import axios from "axios"
import { wrapper } from "axios-cookiejar-support"
import { nosisLogin } from "@scrapers/nosisAuth.js"
import { getRelationshipTypeName } from "@scrapers/nosisRelationshipTypes.js"
import { logger } from "@logger.js"

const DELAY_MS = 1000       // 1 second between requests
const MAX_RETRIES = 3       // max retry attempts on failure

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = MAX_RETRIES): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      logger.warn(`Attempt ${attempt}/${maxRetries} failed, retrying in ${DELAY_MS * attempt}ms...`)
      await delay(DELAY_MS * attempt)
    }
  }
  throw lastError
}

/**
 * Represents a single node in the Nosis relationship tree
 */
export interface NosisRelation {
  taxId: string
  businessName: string
  relationshipType: string
  depth: number
  relations: NosisRelation[]
}

/**
 * Result of searching a person by document/CUIT in Nosis.
 * The resolved `taxId` may differ from the input (e.g. when searching by DNI).
 */
export interface NosisSearchResult {
  taxId: string
  businessName: string
}

/**
 * Low-level Nosis Manager client.
 *
 * Responsibilities:
 *  - Authenticate via Playwright (once) and reuse the session
 *  - Search a document and return its resolved CUIT + name
 *  - Fetch the relationship tree for a given CUIT
 *
 * This is purely a transport adapter — no business logic, no domain types.
 * Higher-level code goes through {@link NosisEnricher} which implements the
 * {@link IEnricher} port.
 */
export class NosisScraper {
  private client

  private constructor(client: ReturnType<typeof axios.create>) {
    this.client = client
  }

  static async create(): Promise<NosisScraper> {
    const { jar, baseUrl } = await nosisLogin()
    const client = wrapper(axios.create({
      jar,
      baseURL: baseUrl,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": `${baseUrl}/net/manager`,
      },
      withCredentials: true,
    }))
    return new NosisScraper(client)
  }

  /**
   * Searches Nosis by document (DNI or CUIT, with or without separators)
   * and returns the resolved CUIT + business name, or null if not found.
   *
   * When searching by DNI, the returned `taxId` is the person's real CUIT.
   */
  async searchAndResolve(document: string): Promise<NosisSearchResult | null> {
    const digits = document.replace(/\D/g, "")
    // Nosis's `documento` field expects different formats depending on length:
    //  - 7 or 8 digits → DNI formatted with thousands separators (e.g. "93.711.662")
    //  - 11 digits     → raw CUIT (no separators)
    // Sending an 8-digit DNI without dots silently returns no results, so we
    // always format it before submitting.
    const documento = this.formatNosisDocumento(digits)

    const response = await withRetry(() =>
      this.client.post(
        "/net/verificacionidentidad/busqueda",
        new URLSearchParams({ documento, denominacion: "", tope: "1" })
      )
    )

    const persona = response.data?.Personas?.[0]
    if (!persona) return null

    // Nosis returns the resolved 11-digit CUIT in the `Documento` field of
    // the search response (`Cuit` is null at this stage). Read from
    // Documento, fall back to Cuit just in case the API changes.
    const cuit = String(persona.Documento ?? persona.Cuit ?? "").replace(/\D/g, "")
    const businessName = String(persona.RazonSocial ?? "")
    if (!cuit || cuit.length !== 11) return null

    return { taxId: cuit, businessName }
  }

  /**
   * Fetches the full relationship tree for an already-resolved CUIT.
   */
  async fetchRelations(taxId: string, businessName: string): Promise<NosisRelation[]> {
    await delay(DELAY_MS)

    const response = await withRetry(() =>
      this.client.post(
        "/net/manager/ConsultaRelacionada/TraerRelaciones",
        new URLSearchParams({
          cuitPadre: "",
          idVinculoPadre: "1",
          cuit: taxId,
          maxNiveles: "3",
          topeNodos: "200",
        })
      )
    )

    const tree = response.data?.Arbol
    if (!tree) return []

    const nodes = this.parseNode(tree)
    if (nodes[0]) {
      nodes[0].businessName = businessName
    }
    return nodes
  }

  /**
   * Formats a numeric document the way Nosis's identity-search endpoint
   * expects it. DNIs (≤8 digits) are split into thousand groups separated
   * with dots; CUITs (11 digits) are returned as-is.
   */
  private formatNosisDocumento(digits: string): string {
    if (digits.length === 11) return digits
    if (digits.length === 0) return ""
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  }

  private parseNode(node: Record<string, unknown>, depth = 0): NosisRelation[] {
    const taxId = String(node["Cuit"] ?? "").replace(/\D/g, "")
    const businessName = String(node["RazonSocial"] ?? "")
    const relationshipType = getRelationshipTypeName(Number(node["Vinculo"] ?? 0))
    const children = (node["Relaciones"] as Record<string, unknown>[] | null) ?? []

    return [{
      taxId,
      businessName,
      relationshipType,
      depth,
      relations: children.flatMap((r) => this.parseNode(r, depth + 1)),
    }]
  }
}