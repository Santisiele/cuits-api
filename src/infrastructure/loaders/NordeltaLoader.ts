import XLSX from "xlsx"
import type { ISourceLoader } from "@ports/interfaces.js"
import type {
  LoadableRow,
  LoadableNode,
  LoadableNodeAttributes,
} from "@domain/entities.js"

// ─── Config ───────────────────────────────────────────────────────────────────

const SOURCE_NAME = "Proveedores Nordelta"
const MAIN_KEY = "main"

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strips every non-digit; returns "" if nothing remains. */
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
 * Builds a LoadableNodeAttributes with only the keys whose values are
 * truthy strings — avoids `exactOptionalPropertyTypes` complaints about
 * assigning `undefined` to optional fields.
 *
 * `customFields` is treated separately: it's always included as an
 * object (possibly empty) when non-empty.
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
 * Source loader for the "Proveedores Nordelta" xlsx file.
 *
 * File format (positional — read by column index, not header):
 *   - Column A: Nombre (short alias, kept as `shortName` in customFields)
 *   - Column B: Razón Social (used as businessName)
 *   - Column C: Cell → phone
 *   - Column D: Mail → email
 *   - Column E: CUIT (with or without dashes)
 *
 * Category = "known": nodes go through the Nosis pipeline for identity
 * resolution and relationship enrichment. That means each row triggers
 * an enrichment call and respects the LoaderService throttling (30-90s
 * between rows/nodes) — same as Poseidon, ConocidosLuchi, Macabeadas.
 */
export class NordeltaLoader implements ISourceLoader {
  readonly sourceName = SOURCE_NAME

  constructor(private readonly filePath: string) {}

  async load(opts: { startRow: number; count: number }): Promise<LoadableRow[]> {
    const workbook = XLSX.readFile(this.filePath)
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new Error("Nordelta workbook has no sheets")
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`)

    const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })
    if (allRows.length < 2) throw new Error("Nordelta file has no data rows")

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
   * Returns null when the CUIT cell is empty — nothing useful to load
   * without a document.
   *
   * The short "Nombre" alias goes into customFields so it's preserved
   * without competing with what Nosis will fill in as businessName.
   */
  private mapRow(row: unknown[], rowNumber: number, loadedAt: string): LoadableRow | null {
    const shortName    = cellAsString(row[0])
    const businessName = cellAsString(row[1])
    const phone        = cellAsString(row[2])
    const email        = cellAsString(row[3])
    const cuit         = digitsOnly(row[4])
    if (!cuit) return null

    const customFields: Record<string, unknown> = {}
    if (shortName) customFields["shortName"] = shortName

    const mainNode: LoadableNode = {
      document: cuit,
      businessName,
      source: SOURCE_NAME,
      attributes: buildAttributes({ phone, email, loadedAt }, customFields),
    }

    return {
      rowId: String(rowNumber),
      nodes: { [MAIN_KEY]: mainNode },
      relationships: [],
      raw: { cuit, shortName, businessName, phone, email },
    }
  }
}