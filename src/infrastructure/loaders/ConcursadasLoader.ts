import XLSX from "xlsx"
import type { ISourceLoader } from "@ports/interfaces.js"
import type {
  LoadableRow,
  LoadableNode,
  LoadableNodeAttributes,
} from "@domain/entities.js"

// ─── Config ───────────────────────────────────────────────────────────────────

const SOURCE_NAME = "Empresas concursadas"
const MAIN_KEY = "main"

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strips every non-digit; returns "" if nothing remains. */
function digitsOnly(raw: unknown): string {
  if (raw == null) return ""
  return String(raw).replace(/\D/g, "")
}

/** Reads a cell as a trimmed string. Returns "" for null/undefined. */
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
 * Heuristic for "is this raw cell value an Excel date serial number?".
 * Excel stores dates as numbers counting days since 1900-01-01 (Lotus epoch).
 * Anything in the [25000, 60000] range is roughly between 1968 and 2064 —
 * realistic for "fecha de publicación en boletín oficial". Below 25000 we
 * assume it's a literal small number (not a date) and skip the conversion.
 */
function looksLikeExcelDateSerial(value: unknown): value is number {
  return typeof value === "number" && value > 25_000 && value < 60_000
}

/**
 * Converts an Excel serial date number (Lotus epoch, days since 1900-01-01)
 * to a dd/mm/yyyy string.
 *
 * We use the standard Excel offset `-25569` (days between Unix epoch
 * 1970-01-01 and Excel epoch 1900-01-01, ignoring Excel's 1900-leap-year bug
 * which only matters for dates before March 1900 — irrelevant here).
 */
function excelSerialToDate(serial: number): string {
  const utcMs = (serial - 25569) * 86400 * 1000
  const date = new Date(utcMs)
  if (isNaN(date.getTime())) return ""
  const day = String(date.getUTCDate()).padStart(2, "0")
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const year = date.getUTCFullYear()
  return `${day}/${month}/${year}`
}

/**
 * Normalises a "publicación en boletín oficial" cell into dd/mm/yyyy.
 *
 * Accepts:
 *  - Excel date serials (numbers) → converted with excelSerialToDate
 *  - Strings already in dd/mm/yyyy → returned as-is (after trim)
 *  - Strings in yyyy-mm-dd (ISO) → reformatted to dd/mm/yyyy
 *  - Anything else → ""
 *
 * Returns "" instead of throwing on invalid input — the row still loads,
 * the publicationDate field just won't be set.
 */
function normalisePublicationDate(raw: unknown): string {
  if (raw == null || raw === "") return ""
  if (looksLikeExcelDateSerial(raw)) return excelSerialToDate(raw)

  const s = String(raw).trim()
  if (!s) return ""

  // Already dd/mm/yyyy or d/m/yyyy
  const ddmm = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s)
  if (ddmm) {
    const [, d, m, y] = ddmm
    return `${d!.padStart(2, "0")}/${m!.padStart(2, "0")}/${y}`
  }

  // ISO yyyy-mm-dd
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) {
    const [, y, m, d] = iso
    return `${d}/${m}/${y}`
  }

  return ""
}

/**
 * Builds a LoadableNodeAttributes with only the keys whose values are
 * truthy strings — avoids `exactOptionalPropertyTypes` complaints about
 * assigning `undefined` to optional fields.
 *
 * `customFields` is treated separately: it's always included as an
 * object (possibly empty), since the repository expects it.
 */
function buildAttributes(
  input: Partial<Record<string, string>>,
  customFields: Record<string, unknown>,
): LoadableNodeAttributes {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) out[key] = value
  }
  if (Object.keys(customFields).length > 0) {
    out["customFields"] = customFields
  }
  return out as LoadableNodeAttributes
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Source loader for the "Empresas concursadas" xlsx file.
 *
 * File format (positional — read by column index, not header):
 *   - Column A: fecha de publicación en boletín oficial (optional, may be
 *               an Excel date serial or a string)
 *   - Column B: business name
 *   - Column C: CUIT (with or without dashes)
 *
 * Each row yields exactly one node tagged with category "to_know" so the
 * LoaderService persists it without Nosis enrichment. The publication date
 * goes into customFields under the key `publicationDate` (camelCase to keep
 * the Cypher property identifier clean).
 */
export class ConcursadasLoader implements ISourceLoader {
  readonly sourceName = SOURCE_NAME

  constructor(private readonly filePath: string) {}

  async load(opts: { startRow: number; count: number }): Promise<LoadableRow[]> {
    // Loading with cellDates: false forces dates to stay as Excel serial
    // numbers, which keeps our normalisation deterministic. If we let the
    // library auto-convert, locale settings can sneak into the output.
    const workbook = XLSX.readFile(this.filePath, { cellDates: false })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new Error("Concursadas workbook has no sheets")
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`)

    const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: true,   // keep numeric cells as numbers (needed for excel date detection)
    })
    if (allRows.length < 2) throw new Error("Concursadas file has no data rows")

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
   * Returns null when the CUIT cell is empty — there's nothing useful to
   * load without a document.
   */
  private mapRow(row: unknown[], rowNumber: number, loadedAt: string): LoadableRow | null {
    const publicationRaw = row[0]
    const businessName = cellAsString(row[1])
    const cuit = digitsOnly(row[2])
    if (!cuit) return null

    const publicationDate = normalisePublicationDate(publicationRaw)

    const customFields: Record<string, unknown> = {}
    if (publicationDate) {
      customFields["publicationDate"] = publicationDate
    }

    const mainNode: LoadableNode = {
      document: cuit,
      businessName,
      source: SOURCE_NAME,
      category: "to_know",
      attributes: buildAttributes({ loadedAt }, customFields),
    }

    return {
      rowId: String(rowNumber),
      nodes: { [MAIN_KEY]: mainNode },
      relationships: [],
      raw: { cuit, businessName, publicationDate },
    }
  }
}