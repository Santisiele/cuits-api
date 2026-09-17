import axios from "axios"
import { wrapper } from "axios-cookiejar-support"
import { nosisLogin } from "@scrapers/nosisAuth.js"

const NRO_GRUPO_VR = "99001"

const TOKEN_PATTERN = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i
const VI_IDENTIFIER_PATTERN = /data-identificador="([^"]+)"\s+data-prefijo="VI"/i
const BIRTHDAY_PATTERN = /F\.\s*nacimiento:\s*<\/td>\s*<td>\s*(\d{1,2}\/\d{1,2}\/\d{4})/i

export interface SacIdentity {
  taxId: string
  businessName: string
}

export class SacScraper {
  private constructor(
    private readonly client: ReturnType<typeof axios.create>,
    private readonly baseUrl: string,
    private token: string
  ) {}

  static async create(): Promise<SacScraper> {
    const { jar, baseUrl } = await nosisLogin()
    const client = wrapper(
      axios.create({
        jar,
        baseURL: baseUrl,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          Origin: baseUrl,
        },
        withCredentials: true,
      })
    )
    const scraper = new SacScraper(client, baseUrl, "")
    await scraper.refreshToken("")
    return scraper
  }

  async searchDocument(document: string): Promise<SacIdentity | null> {
    const digits = document.replace(/\D/g, "")
    const response = await this.client.post(
      "/net/verificacionidentidad/busqueda",
      new URLSearchParams({ documento: digits, denominacion: "", tope: "1" })
    )
    const persona = response.data?.Personas?.[0]
    if (!persona) return null
    const taxId = String(persona.Documento ?? "").replace(/\D/g, "")
    if (taxId.length !== 11) return null
    return { taxId, businessName: String(persona.RazonSocial ?? "") }
  }

  async fetchBirthday(taxId: string, denominacion = ""): Promise<string | null> {
    await this.refreshToken(taxId, denominacion)

    const consultar = await this.client.post(
      "/net/resultado/consultar",
      new URLSearchParams({
        documento: taxId,
        denominacion,
        idCalculoCda: "0",
        nroGrupoVR: NRO_GRUPO_VR,
        claveConsulta: "",
        __RequestVerificationToken: this.token,
      })
    )

    if (consultar.data?.ConsultaOk !== true) return null
    const claveConsulta = String(consultar.data?.ClaveConsulta ?? "")
    const index = String(consultar.data?.ContenidoHtml ?? "")
    const identifier = VI_IDENTIFIER_PATTERN.exec(index)?.[1]
    if (!claveConsulta || !identifier) return null

    const block = await this.client.post(
      "/net/body/consulta",
      new URLSearchParams({
        id: identifier,
        identificadorCdaParaVR: "",
        claveConsulta,
      })
    )

    if (block.data?.ConsultaOk !== true) return null
    const html = String(block.data?.ContenidoHtml ?? "")
    const raw = BIRTHDAY_PATTERN.exec(html)?.[1]
    return raw ? normaliseDate(raw) : null
  }

  private async refreshToken(documento: string, denominacion = ""): Promise<void> {
    const params = new URLSearchParams({
      documento,
      denominacion,
      nroGrupoVR: NRO_GRUPO_VR,
      idCalculoCda: "0",
    })
    const page = await this.client.get(`/net/resultado?${params.toString()}`, {
      headers: { Accept: "text/html", "X-Requested-With": "" },
      responseType: "text",
    })
    const found = TOKEN_PATTERN.exec(String(page.data))?.[1]
    if (found) this.token = found
    this.client.defaults.headers.common["Referer"] =
      `${this.baseUrl}/net/resultado?${params.toString()}`
  }
}

function normaliseDate(raw: string): string {
  const [day, month, year] = raw.split("/")
  if (!day || !month || !year) return raw
  return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`
}
