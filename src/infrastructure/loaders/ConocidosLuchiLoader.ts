import XLSX from "xlsx"
import type { ISourceLoader } from "@ports/interfaces.js"
import type { LoadableRow, LoadableNode, LoadableNodeAttributes } from "@domain/entities.js"

// ─── Config ───────────────────────────────────────────────────────────────────

const SOURCE_NAME = "conocidos-luchi"
const MAIN_KEY = "main"

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Formats a Date as dd/mm/yyyy. */
function formatDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`
}

/**
 * Heuristic: returns true if the value looks like an Excel serial date
 * (a number between 25569 = 1970-01-01 and 2958465 = 9999-12-31).
 * Birthdays predate 1970 in many cases, so we use a lower bound of 1
 * (= 1900-01-01) instead, since this loader's birthday column is the
 * only place we expect such values.
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
 * Reads a cell as a trimmed string, formatting any value that represents
 * a date (Excel-native Date OR Excel serial-number date) as dd/mm/yyyy.
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
 * Source loader for the "Conocidos Luchi" xlsx file.
 *
 * File format:
 *   - Single sheet, headers in row 1
 *   - Column A: CUIT (with or without dashes — dashes are stripped on read)
 *   - Column B: birthday (Excel date or "dd/mm/yyyy" string)
 *
 * Each row yields exactly one node (role "main"), tagged with the source
 * `conocidos-luchi`. The business name is intentionally left blank — the
 * LoaderService will fall back to Nosis's RazonSocial during enrichment.
 *
 * Reads are positional (columns A and B) rather than by header name,
 * because the original file uses non-standard column labels.
 */
export class ConocidosLuchiLoader implements ISourceLoader {
  readonly sourceName = SOURCE_NAME

  constructor(private readonly filePath: string) {}

  async load(opts: { startRow: number; count: number }): Promise<LoadableRow[]> {
    const workbook = XLSX.readFile(this.filePath)
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new Error("Conocidos Luchi workbook has no sheets")
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`)

    const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })
    if (allRows.length < 2) throw new Error("Conocidos Luchi file has no data rows")

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
   * Returns null when the CUIT cell is empty or malformed, since there's
   * nothing to look up for that row.
   */
  private mapRow(row: unknown[], rowNumber: number, loadedAt: string): LoadableRow | null {
    const cuit = digitsOnly(row[0])
    if (!cuit) return null

    const birthday = cellAsString(row[1])

    const mainNode: LoadableNode = {
      document: cuit,
      // Empty — Nosis's RazonSocial will be used as fallback by the service.
      businessName: "",
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
      raw: { cuit, birthday },
    }
  }
}