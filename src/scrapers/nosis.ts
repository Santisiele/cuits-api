import axios from "axios"
import { wrapper } from "axios-cookiejar-support"
import { nosisLogin } from "@scrapers/nosisAuth.js"
import { getRelationshipTypeName } from "@scrapers/nosisRelationshipTypes.js"
import { logger } from "@logger"

const DELAY_MS = 1000       // 1 second between requests
const MAX_RETRIES = 3       // max retry attempts on failure

/**
 * Waits for a given number of milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retries an async function up to maxRetries times on failure
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of retry attempts
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = MAX_RETRIES): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      logger.warn(`Attempt ${attempt}/${maxRetries} failed, retrying in ${DELAY_MS * attempt}ms...`)
      await delay(DELAY_MS * attempt) // exponential backoff
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
 * Scraper for Nosis Manager relationship tree.
 * Uses Playwright for login and internal API for data fetching.
 */
export class NosisScraper {
  private client

  private constructor(client: ReturnType<typeof axios.create>) {
    this.client = client
  }

  /**
   * Creates a new NosisScraper instance with an authenticated session
   */
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
   * Searches for a Tax ID on Nosis
   * @param taxId - Tax ID without dashes
   */
  private async search(taxId: string): Promise<string> {
    const response = await withRetry(() =>
      this.client.post(
        "/net/verificacionidentidad/busqueda",
        new URLSearchParams({
          documento: taxId,
          denominacion: "",
          tope: "1",
        })
      )
    )

    const persona = response.data?.Personas?.[0]
    return String(persona?.RazonSocial ?? "")
  }

  /**
   * Fetches the relationship tree for a given Tax ID
   * @param taxId - Tax ID without dashes
   * @param businessName - Business name from search result
   */
  private async fetchRelations(taxId: string, businessName: string): Promise<NosisRelation[]> {
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
   * Recursively parses a node from the Nosis API response
   * @param node - Raw node from Nosis API
   * @param depth - Current depth in the tree (0 = root)
   */
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

  /**
   * Runs the full scraping flow: search and fetch relationships
   * @param taxId - Tax ID to scrape (without dashes)
   */
  async scrape(taxId: string): Promise<NosisRelation[]> {
    const businessName = await this.search(taxId)
    return this.fetchRelations(taxId, businessName)
  }
}