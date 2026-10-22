export interface LevelOption {
  value: number
  label: string
}

export interface TrustLevelAssignment {
  taxId: string
  value: number
  label: string
  reason: string
}

export type TrustLevelImportSkip = "cuit" | "level"

export interface ParsedTrustLevels {
  assignments: TrustLevelAssignment[]
  skipped: { row: number; reason: TrustLevelImportSkip; value: string }[]
}

const COLUMNS = { cuit: ["cuit"], level: ["segmento", "nivel"], reason: ["motivo"] } as const

function normalise(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

function cell(raw: unknown): string {
  return raw == null ? "" : String(raw).trim().replace(/\s+/g, " ")
}

function findColumn(header: string[], accepted: readonly string[]): number {
  return header.findIndex((name) => accepted.includes(name))
}

export function parseTrustLevels(rows: unknown[][], levels: LevelOption[]): ParsedTrustLevels {
  const [rawHeader, ...dataRows] = rows
  if (!rawHeader) throw new Error("The file has no header row")
  const header = rawHeader.map(normalise)
  const cuitColumn = findColumn(header, COLUMNS.cuit)
  const levelColumn = findColumn(header, COLUMNS.level)
  const reasonColumn = findColumn(header, COLUMNS.reason)
  if (cuitColumn === -1 || levelColumn === -1) throw new Error("The file needs a CUIT and a Segmento column")

  const byLabel = new Map(levels.map((level) => [normalise(level.label), level]))
  const assignments = new Map<string, TrustLevelAssignment>()
  const skipped: ParsedTrustLevels["skipped"] = []

  dataRows.forEach((row, index) => {
    if (row.every((value) => cell(value) === "")) return
    const taxId = cell(row[cuitColumn]).replace(/\D/g, "")
    if (taxId.length !== 11) {
      skipped.push({ row: index + 2, reason: "cuit", value: cell(row[cuitColumn]) })
      return
    }
    const level = byLabel.get(normalise(row[levelColumn]))
    if (!level) {
      skipped.push({ row: index + 2, reason: "level", value: cell(row[levelColumn]) })
      return
    }
    const reason = reasonColumn === -1 ? "" : cell(row[reasonColumn])
    assignments.set(taxId, { taxId, value: level.value, label: level.label, reason })
  })

  return { assignments: [...assignments.values()], skipped }
}

export function describeTrustLevelImport(parsed: ParsedTrustLevels, missing: string[]): string[] {
  const byLabel = new Map<string, { count: number; withReason: number }>()
  for (const assignment of parsed.assignments) {
    const entry = byLabel.get(assignment.label) ?? { count: 0, withReason: 0 }
    entry.count++
    if (assignment.reason) entry.withReason++
    byLabel.set(assignment.label, entry)
  }
  const lines = [...byLabel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, entry]) => `${label}: ${entry.count} CUITs, ${entry.withReason} with a reason`)
  if (lines.length === 0) lines.push("Nothing to assign")
  lines.push(`Not in the graph: ${missing.length}${missing.length ? ` (${missing.slice(0, 10).join(", ")})` : ""}`)
  lines.push(`Skipped rows: ${parsed.skipped.length}`)
  for (const skip of parsed.skipped) lines.push(`  row ${skip.row}: bad ${skip.reason} "${skip.value}"`)
  return lines
}
