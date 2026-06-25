import XLSX from "xlsx"
import type { ISourceLoader } from "@ports/interfaces.js"
import type { LoadableRow, LoadableNode, LoadableNodeAttributes } from "@domain/entities.js"

// ─── Config ───────────────────────────────────────────────────────────────────

const SOURCE_NAME = "Macabeadas 2026"
const MAIN_KEY = "main"

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Formats a Date as dd/mm/yyyy. */
function formatDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`
}

/**
 * Heuristic: returns true if the value looks like an Excel serial date.
 * Lower bound of 1 (1900-01-01) since birthdays can predate 1970.
 */
function looksLikeExcelDateSerial(n: number): boolean {
  return Number.isFinite(n) && n >= 1 && n <= 2958465
}

/**
 * Converts an Excel serial date number into a JavaScript Date.
 * Excel days are counted from 1900-01-01, but with a 1900 leap-year bug
 * that we offset by using the Lotus epoch (25569 days from Unix epoch).
 */
function excelSerialToDate(serial: number): Date {
  const utcMs = Math.round((serial - 25569) * 86400 * 1000)
  return new Date(utcMs)
}

/**
 * Reads a cell as a trimmed string, formatting Excel-native Dates and
 * Excel serial-number dates as dd/mm/yyyy.
 */
function cellAsString(raw: unknown): string {
  if (raw == null) return ""
  if (raw instanceof Date) return formatDate(raw)
  if (typeof raw === "number" && looksLikeExcelDateSerial(raw)) {
    return formatDate(excelSerialToDate(raw))
  }
  return String(raw).trim()
}

/** Strips every non-digit; returns empty string if nothing remains. */
function digitsOnly(raw: unknown): string {
  if (raw == null) return ""
  return String(raw).replace(/\D/g, "")
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
 * Source loader for the "Macabeadas 2026" xlsx file.
 *
 * File format (positional — no header lookups, since the original file's
 * labels may vary in casing or accents):
 *   - Column A: NOMBRE COMPLETO
 *   - Column B: CUIT (with or without dashes — dashes are stripped)
 *   - Column C: FECHA DE NACIMIENTO (Excel date or "dd/mm/yyyy" string)
 *
 * Each row yields exactly one node (role "main"), tagged with the source
 * `Macabeadas 2026`. The business name is taken from column A, falling
 * back to whatever Nosis returns if the column is empty.
 */
export class MacabeadasLoader implements ISourceLoader {
  readonly sourceName = SOURCE_NAME

  constructor(private readonly filePath: string) {}

  async load(opts: { startRow: number; count: number }): Promise<LoadableRow[]> {
    const workbook = XLSX.readFile(this.filePath)
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new Error("Macabeadas workbook has no sheets")
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`)

    const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })
    if (allRows.length < 2) throw new Error("Macabeadas file has no data rows")

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
    const birthday = cellAsString(row[2])

    const mainNode: LoadableNode = {
      document: cuit,
      businessName,
      source: SOURCE_NAME,
      attributes: buildAttributes({
        birthday,
        loadedAt,
      }),
    }

    return {
      rowId: String(rowNumber),
      nodes: { [MAIN_KEY]: mainNode },
      relationships: [],
      raw: { cuit, businessName, birthday },
    }
  }
}