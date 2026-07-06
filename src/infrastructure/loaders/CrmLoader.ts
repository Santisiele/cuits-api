import XLSX from "xlsx"
import type { ISourceLoader } from "@ports/interfaces.js"
import type {
  LoadableRow,
  LoadableNode,
  LoadableNodeAttributes,
} from "@domain/entities.js"

// ─── Config ───────────────────────────────────────────────────────────────────

const SOURCE_NAME = "Clientes CRM"
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
 * Builds a LoadableNodeAttributes with only the keys whose values are
 * truthy strings — avoids `exactOptionalPropertyTypes` complaints about
 * assigning `undefined` to optional fields.
 *
 * `customFields` is only included when non-empty.
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
 * Source loader for the "Clientes CRM" xlsx file.
 *
 * File format (positional — read by column index, not header):
 *   - Column A: CUIT (with or without dashes)
 *   - Column B: Nombre de cuenta → businessName
 *   - Column C: Teléfono principal → phone
 *   - Column D: Dirección 1: ciudad → customFields.city
 *   - Column E: Contacto principal → customFields.mainContact
 *   - Column F: Correo electrónico (Contacto principal) → email
 *   - Column G: Razón para el estado → customFields.statusReason
 *   - Column H: Propietario → customFields.owner
 *   - Column I: Segmento → customFields.segment
 *
 * Category = "known": nodes go through the Nosis pipeline for identity
 * resolution and relationship enrichment (same throttling as the other
 * "conocidos" loaders).
 *
 * All custom fields use camelCase keys because they land as Cypher
 * property identifiers verbatim — spaces and special characters would
 * require awkward backtick quoting in queries later on.
 */
export class CrmLoader implements ISourceLoader {
  readonly sourceName = SOURCE_NAME

  constructor(private readonly filePath: string) {}

  async load(opts: { startRow: number; count: number }): Promise<LoadableRow[]> {
    const workbook = XLSX.readFile(this.filePath)
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new Error("CRM workbook has no sheets")
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`)

    const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })
    if (allRows.length < 2) throw new Error("CRM file has no data rows")

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
   */
  private mapRow(row: unknown[], rowNumber: number, loadedAt: string): LoadableRow | null {
    const cuit         = digitsOnly(row[0])
    if (!cuit) return null

    const businessName = cellAsString(row[1])
    const phone        = cellAsString(row[2])
    const city         = cellAsString(row[3])
    const mainContact  = cellAsString(row[4])
    const email        = cellAsString(row[5])
    const statusReason = cellAsString(row[6])
    const owner        = cellAsString(row[7])
    const segment      = cellAsString(row[8])

    const customFields: Record<string, unknown> = {}
    if (city)         customFields["city"]         = city
    if (mainContact)  customFields["mainContact"]  = mainContact
    if (statusReason) customFields["statusReason"] = statusReason
    if (owner)        customFields["owner"]        = owner
    if (segment)      customFields["segment"]      = segment

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
      raw: { cuit, businessName, phone, email, city, mainContact, statusReason, owner, segment },
    }
  }
}