import XLSX from "xlsx"
import type { ISourceLoader } from "@ports/interfaces.js"
import type { LoadableRow, LoadableNode, LoadableNodeAttributes } from "@domain/entities.js"

// ─── Config ───────────────────────────────────────────────────────────────────

const SOURCE_NAME = "Empresas Credivico"
const MAIN_KEY = "main"

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strips every non-digit; returns empty string if nothing remains. */
function digitsOnly(raw: unknown): string {
  if (raw == null) return ""
  return String(raw).replace(/\D/g, "")
}

/** Reads a cell as a trimmed string. */
function cellAsString(raw: unknown): string {
  if (raw == null) return ""
  return String(raw).trim()
}

/** Returns today as dd/mm/yyyy. */
function todayString(): string {
  const d = new Date()
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`
}

/**
 * Builds a LoadableNodeAttributes object with only the keys whose values
 * are truthy strings. Avoids `exactOptionalPropertyTypes` issues that
 * arise from assigning `undefined` to optional fields.
 */
function buildAttributes(input: Partial<Record<string, string>>): LoadableNodeAttributes {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) out[key] = value
  }
  return out as LoadableNodeAttributes
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Source loader for the "Empresas Credivico" xlsx file.
 *
* File format (positional — read by column index, not header):
 *   - Column A: Nombre / Razón social
 *   - Column B: CUIT (with or without dashes — dashes are stripped)
 *
 * Each row yields exactly one node (role "main"), tagged with the source
 * `Empresas Credivico`. The business name is taken from column B, with
 * Nosis's RazonSocial used as fallback when the column is empty.
 *
 * The node will be marked as `inMyBase: true` because the LoaderService
 * routes all source-loaded nodes through `upsertBaseNode`. This is the
 * intended behaviour: once we have a company in our base, the
 * "Empresas a buscar" view excludes it automatically (it only shows
 * companies that are NOT in our base).
 */
export class CredivicoLoader implements ISourceLoader {
  readonly sourceName = SOURCE_NAME

  constructor(private readonly filePath: string) { }

  async load(opts: { startRow: number; count: number }): Promise<LoadableRow[]> {
    const workbook = XLSX.readFile(this.filePath)
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new Error("Credivico workbook has no sheets")
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`)

    const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })
    if (allRows.length < 2) throw new Error("Credivico file has no data rows")

    // Skip the header row.
    const dataRows = allRows.slice(1) as unknown[][]
    const slice = dataRows.slice(opts.startRow - 1, opts.startRow - 1 + opts.count)
    const loadedAt = todayString()

    return slice
      .map((row, i) => this.mapRow(row, opts.startRow + i, loadedAt))
      .filter((r): r is LoadableRow => r !== null)
  }

  // ─── Row mapping ──────────────────────────────────────────────────────────

  /**
   * Converts a single raw row into a LoadableRow.
   * Returns null when the CUIT cell is empty, since there's nothing to
   * look up for that row.
   */
  private mapRow(row: unknown[], rowNumber: number, loadedAt: string): LoadableRow | null {
    const cuit = digitsOnly(row[1])
    if (!cuit) return null

    const businessName = cellAsString(row[0])

    const mainNode: LoadableNode = {
      document: cuit,
      businessName,
      source: SOURCE_NAME,
      attributes: buildAttributes({ loadedAt }),
    }

    return {
      rowId: String(rowNumber),
      nodes: { [MAIN_KEY]: mainNode },
      relationships: [],
      raw: { cuit, businessName },
    }
  }
}