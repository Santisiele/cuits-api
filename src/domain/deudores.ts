import type { LoadableRow } from "@domain/entities.js"

export interface DeudorOperation {
  entityName: string
  date: string
  situation: string
  totalLoan: string
}

export interface DeudoresGroup {
  taxId: string
  businessName: string
  source: string
  operations: DeudorOperation[]
}

export type DeudoresSkipReason = "cuit" | "period" | "situation" | "amount" | "entity"

export interface DeudoresSkippedRow {
  row: number
  reason: DeudoresSkipReason
}

export interface ParsedDeudores {
  groups: DeudoresGroup[]
  skipped: DeudoresSkippedRow[]
}

export interface DeudoresSourceSummary {
  source: string
  cuitCount: number
  operationCount: number
  periods: string[]
}

const SOURCE_PREFIX = "Deudores "
const MAX_LISTED_ROWS = 10

const COLUMNS = {
  period: ["fecha"],
  cuit: ["numeroidentificacion", "cuit"],
  situation: ["situacion"],
  totalLoan: ["prestamototal"],
  entity: ["banco", "descripcion"],
} as const

const NAME_COLUMN = "nombre"

type Columns = Record<keyof typeof COLUMNS, number> & { name: number }

const LEGAL_SUFFIX =
  /[\s,]+(S\.?\s*A\.?\s*U\.?|S\.?\s*R\.?\s*L\.?|S\.?\s*A\.?\s*S\.?|S\.?\s*C\.?\s*A\.?|S\.?\s*A\.?)$/i

const CONNECTORS = new Set(["de", "del", "la", "las", "los", "el", "y", "e"])

const CUIT_PATTERN = /^\d{11}$/
const PERIOD_PATTERN = /^(\d{4})(\d{2})$/
const SITUATION_PATTERN = /^[1-9]\d*$/
const AMOUNT_PATTERN = /^\d+$/

function normaliseHeader(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

function cell(raw: unknown): string {
  return raw == null ? "" : String(raw).trim()
}

function capitalise(word: string): string {
  return word.charAt(0).toLocaleUpperCase("es") + word.slice(1)
}

export function cleanEntityName(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ")
  const withoutSuffix = collapsed.replace(LEGAL_SUFFIX, "")
  return withoutSuffix
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word, index) => {
      const lower = word.toLocaleLowerCase("es")
      return index > 0 && CONNECTORS.has(lower) ? lower : capitalise(lower)
    })
    .join(" ")
}

export function deudoresSourceName(entityName: string): string {
  return SOURCE_PREFIX + cleanEntityName(entityName)
}

function findColumns(header: unknown[]): Columns {
  const names = header.map(normaliseHeader)
  const missing: string[] = []
  const indexes = { name: names.indexOf(NAME_COLUMN) } as Columns
  for (const [key, accepted] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, readonly string[]][]) {
    const index = names.findIndex((name) => accepted.includes(name))
    if (index === -1) missing.push(accepted.join(" or "))
    indexes[key] = index
  }
  if (missing.length > 0) throw new Error(`Deudores file is missing columns: ${missing.join(", ")}`)
  return indexes
}

function periodDate(raw: unknown): string {
  const match = PERIOD_PATTERN.exec(cell(raw))
  if (!match) return ""
  const month = Number(match[2])
  if (month < 1 || month > 12) return ""
  return `01/${match[2]}/${match[1]}`
}

function readOperation(
  row: unknown[],
  columns: Columns
): { taxId: string; businessName: string; operation: DeudorOperation } | DeudoresSkipReason {
  const taxId = cell(row[columns.cuit]).replace(/\D/g, "")
  if (!CUIT_PATTERN.test(taxId)) return "cuit"

  const date = periodDate(row[columns.period])
  if (!date) return "period"

  const situation = cell(row[columns.situation])
  if (!SITUATION_PATTERN.test(situation)) return "situation"

  const totalLoan = cell(row[columns.totalLoan])
  if (!AMOUNT_PATTERN.test(totalLoan)) return "amount"

  const entityName = cell(row[columns.entity]).replace(/\s+/g, " ")
  if (!cleanEntityName(entityName)) return "entity"

  const businessName = columns.name === -1 ? "" : cell(row[columns.name]).replace(/\s+/g, " ")
  return { taxId, businessName, operation: { entityName, date, situation, totalLoan } }
}

export function parseDeudores(rows: unknown[][]): ParsedDeudores {
  const [header, ...dataRows] = rows
  if (!header) throw new Error("Deudores file has no header row")
  const columns = findColumns(header)

  const groups = new Map<string, DeudoresGroup>()
  const skipped: DeudoresSkippedRow[] = []

  dataRows.forEach((row, index) => {
    if (row.every((value) => cell(value) === "")) return

    const read = readOperation(row, columns)
    if (typeof read === "string") {
      skipped.push({ row: index + 2, reason: read })
      return
    }

    const source = deudoresSourceName(read.operation.entityName)
    const key = `${read.taxId}|${source}`
    const group = groups.get(key) ?? { taxId: read.taxId, businessName: "", source, operations: [] }
    if (!group.businessName) group.businessName = read.businessName
    group.operations.push(read.operation)
    groups.set(key, group)
  })

  return { groups: [...groups.values()], skipped }
}

function periodOf(date: string): string {
  const [, month, year] = date.split("/")
  return `${year}-${month}`
}

export function summariseDeudoresSources(groups: DeudoresGroup[]): DeudoresSourceSummary[] {
  const bySource = new Map<string, { cuits: Set<string>; operationCount: number; periods: Set<string> }>()
  for (const group of groups) {
    const entry = bySource.get(group.source) ?? { cuits: new Set(), operationCount: 0, periods: new Set() }
    entry.cuits.add(group.taxId)
    entry.operationCount += group.operations.length
    for (const operation of group.operations) entry.periods.add(periodOf(operation.date))
    bySource.set(group.source, entry)
  }

  return [...bySource.entries()]
    .map(([source, entry]) => ({
      source,
      cuitCount: entry.cuits.size,
      operationCount: entry.operationCount,
      periods: [...entry.periods].sort(),
    }))
    .sort((a, b) => a.source.localeCompare(b.source))
}

export function describeDeudoresDryRun(parsed: ParsedDeudores): string[] {
  const lines = summariseDeudoresSources(parsed.groups).map(
    (summary) =>
      `${summary.source}: ${summary.cuitCount} CUITs, ${summary.operationCount} operations, ` +
      `periods ${summary.periods.join(", ")}`
  )
  if (lines.length === 0) lines.push("No rows to load")

  if (parsed.skipped.length === 0) {
    lines.push("Skipped rows: none")
    return lines
  }

  lines.push(`Skipped rows: ${parsed.skipped.length}`)
  const reasons = [...new Set(parsed.skipped.map((skip) => skip.reason))].sort()
  for (const reason of reasons) {
    const rows = parsed.skipped.filter((skip) => skip.reason === reason).map((skip) => skip.row)
    const shown = rows.slice(0, MAX_LISTED_ROWS).join(", ")
    const more = rows.length > MAX_LISTED_ROWS ? ` and ${rows.length - MAX_LISTED_ROWS} more` : ""
    lines.push(`  bad ${reason}: ${rows.length} (rows ${shown}${more})`)
  }
  return lines
}

export function deudoresLoadableRows(groups: DeudoresGroup[], loadedAt: string): LoadableRow[] {
  return groups.map((group) => ({
    rowId: `${group.taxId} ${group.source} (${group.operations.length} ops)`,
    nodes: {
      main: {
        document: group.taxId,
        businessName: group.businessName,
        source: group.source,
        category: "to_know",
        attributes: {
          loadedAt,
          customFields: { financieraOperations: JSON.stringify(group.operations) },
        },
      },
    },
    relationships: [],
    raw: { taxId: group.taxId, source: group.source, opCount: group.operations.length },
  }))
}
