export const WEB_RESEARCH_PRICES_USD = {
  inputPerMillionTokens: 4,
  outputPerMillionTokens: 20,
  cacheReadPerMillionTokens: 0.2,
  perThousandWebSearches: 10,
} as const

export const DEFAULT_MONTHLY_LIMIT_USD = 20

export type WebResearchStatus = "done" | "failed"

export type WebResearchRejection =
  | "invalid_cuit"
  | "invalid_limit"
  | "cuit_not_found"
  | "budget_exhausted"
  | "research_failed"
  | "research_off"
  | "research_not_found"
  | "already_archived"
  | "not_archived"

export interface ResearchUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  webSearches: number
}

export interface ResearchSource {
  url: string
  title: string
}

export interface ResearchFindings {
  summary: string
  sources: ResearchSource[]
  model: string
  usage: ResearchUsage
}

export interface WebResearch {
  id: string
  taxId: string
  requestedAt: string
  requestedBy: string
  status: WebResearchStatus
  summary: string
  sources: ResearchSource[]
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  webSearches: number
  costUsd: number
}

export interface WebResearchWithName extends WebResearch {
  businessName: string
}

export interface ResearchBudget {
  monthlyLimitUsd: number
  spentThisMonthUsd: number
  researchCountThisMonth: number
}

export interface ResearchSubject {
  businessName: string
  taxId: string
}

export interface ResearchRequest {
  system: string
  userMessage: string
}

export interface CitedBlock {
  type: string
  text?: string
  citations?: ReadonlyArray<{ type: string; url?: string; title?: string | null }> | null
}

export const EMPTY_USAGE: ResearchUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 }

export class ResearcherError extends Error {
  constructor(message: string, readonly usage: ResearchUsage, readonly model: string) {
    super(message)
    this.name = "ResearcherError"
  }
}

const CUIT_PATTERN = /^\d{11}$/

export function isValidResearchCuit(taxId: string): boolean {
  return CUIT_PATTERN.test(taxId)
}

const RESEARCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidResearchId(id: string): boolean {
  return RESEARCH_ID_PATTERN.test(id)
}

export function archiveRejection(research: { archivedAt: string | null } | null): WebResearchRejection | null {
  if (!research) return "research_not_found"
  return research.archivedAt === null ? null : "already_archived"
}

export function restoreRejection(research: { archivedAt: string | null } | null): WebResearchRejection | null {
  if (!research) return "research_not_found"
  return research.archivedAt === null ? "not_archived" : null
}

export function isValidMonthlyLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function costFromUsage(usage: ResearchUsage): number {
  const prices = WEB_RESEARCH_PRICES_USD
  return roundUsd(
    (usage.inputTokens * prices.inputPerMillionTokens) / 1_000_000 +
      (usage.outputTokens * prices.outputPerMillionTokens) / 1_000_000 +
      (usage.cacheReadTokens * prices.cacheReadPerMillionTokens) / 1_000_000 +
      (usage.webSearches * prices.perThousandWebSearches) / 1_000
  )
}

export function addUsage(a: ResearchUsage, b: ResearchUsage): ResearchUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    webSearches: a.webSearches + b.webSearches,
  }
}

const BUENOS_AIRES_OFFSET_HOURS = 3

export function startOfMonthInBuenosAires(now: Date): string {
  const local = new Date(now.getTime() - BUENOS_AIRES_OFFSET_HOURS * 3_600_000)
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1, BUENOS_AIRES_OFFSET_HOURS)).toISOString()
}

export function isBudgetExhausted(spentUsd: number, monthlyLimitUsd: number): boolean {
  return spentUsd >= monthlyLimitUsd
}

const SYSTEM_PROMPT = [
  "Sos un analista que investiga empresas y personas de Argentina en fuentes públicas de la web.",
  "Escribí en español un resumen de la información pública, comercial y profesional que encuentres: actividad, noticias, Boletín Oficial (constitución, autoridades), concursos y quiebras, juicios relevantes, cargos y empresas vinculadas.",
  "No incluyas nada de la vida personal.",
  "Cada afirmación tiene que estar respaldada por una fuente citada.",
  "Si hay homónimos o dudas de que se trate de la misma entidad, decilo explícitamente.",
  "Si no encontrás nada relevante, decilo en lugar de rellenar.",
  "Respondé únicamente con el informe final, todo en español. No narres lo que vas a buscar ni lo que estás haciendo.",
  "Usá Markdown: títulos con ##, listas con guiones, negritas para lo importante y enlaces con [texto](url).",
].join("\n")

export function buildResearchRequest(subject: ResearchSubject): ResearchRequest {
  const name = subject.businessName.trim()
  return {
    system: SYSTEM_PROMPT,
    userMessage: `Investigá a ${name === "" ? "la entidad" : `"${name}"`}, CUIT ${subject.taxId}.`,
  }
}

function isToolBlock(block: CitedBlock): boolean {
  return block.type.endsWith("tool_use") || block.type.endsWith("tool_result")
}

export function summaryFromBlocks(blocks: readonly CitedBlock[]): string {
  const lastTool = blocks.reduce((last, block, index) => (isToolBlock(block) ? index : last), -1)
  return blocks
    .slice(lastTool + 1)
    .map((block) => (block.type === "text" ? block.text ?? "" : ""))
    .join("")
    .trim()
}

export function sourcesFromBlocks(blocks: readonly CitedBlock[]): ResearchSource[] {
  const byUrl = new Map<string, ResearchSource>()
  for (const block of blocks) {
    for (const citation of block.citations ?? []) {
      if (citation.type !== "web_search_result_location" || !citation.url || byUrl.has(citation.url)) continue
      byUrl.set(citation.url, { url: citation.url, title: citation.title || citation.url })
    }
  }
  return [...byUrl.values()]
}
