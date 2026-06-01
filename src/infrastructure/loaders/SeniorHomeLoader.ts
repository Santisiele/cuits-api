import XLSX from "xlsx"
import type { ISourceLoader } from "@ports/interfaces.js"
import type { LoadableRow, LoadableNode } from "@domain/entities.js"

// ─── Config ───────────────────────────────────────────────────────────────────

const SOURCE_RESIDENT = "Residente Senior Home"
const SOURCE_RESPONSIBLE = "Responsables Senior Home"
const RELATIONSHIP_TYPE = "Responsible"

const RESIDENT_KEY = "resident"
const RESPONSIBLE_KEY = "responsible"

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Reads a cell as a trimmed string, formatting Excel-native Dates as dd/mm/yyyy. */
function cellAsString(raw: unknown): string {
  if (raw == null) return ""
  if (raw instanceof Date) {
    const d = raw
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`
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
function buildAttributes(input: Partial<Record<string, string>>): import("@domain/entities.js").LoadableNodeAttributes {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) out[key] = value
  }
  return out as import("@domain/entities.js").LoadableNodeAttributes
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Source loader for the Senior Home CSV/XLSX.
 *
 * Each input row potentially yields two nodes within the same row:
 *  - `resident`    — looked up by DocumentoResidente
 *  - `responsible` — looked up by CUIT (preferred) or DNI (fallback)
 *
 * The loader declares an inter-node relationship `responsible → resident`
 * of type "Responsible". The {@link LoaderService} will create this
 * relationship only when both nodes were actually loaded.
 *
 * The loader does NOT decide whether to skip the responsible if the
 * resident fails — that's the service's job. The loader only describes the
 * row's structure and lets the service apply its policy.
 *
 * Special behaviour: if the input row has no responsible document at all,
 * the `responsible` node is simply omitted from the row, so the service
 * never tries to resolve it and the relationship is skipped naturally.
 */
export class SeniorHomeLoader implements ISourceLoader {
  readonly sourceName = "seniorHome"

  constructor(private readonly filePath: string) {}

  async load(opts: { startRow: number; count: number }): Promise<LoadableRow[]> {
    const workbook = XLSX.readFile(this.filePath)
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new Error("Senior Home workbook has no sheets")
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`)

    const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })
    if (allRows.length < 2) throw new Error("Senior Home file has no data rows")

    const headerRow = allRows[0] as string[]
    const dataRows = allRows.slice(1) as unknown[][]
    const idx = this.indexColumns(headerRow)

    const slice = dataRows.slice(opts.startRow - 1, opts.startRow - 1 + opts.count)
    const loadedAt = todayString()

    return slice.map((row, i) => this.mapRow(row, idx, opts.startRow + i, loadedAt))
  }

  // ─── Column indexing ──────────────────────────────────────────────────────

  /**
   * Maps each expected column header to its column index in the input file,
   * supporting both exact matches and "starts with" for variable suffixes
   * like "Fecha de ingreso(fecha_de_ingreso)".
   */
  private indexColumns(headerRow: string[]): ColumnIndex {
    const norm = headerRow.map((h) => String(h).trim().toLowerCase())
    const exact = (name: string) => norm.findIndex((h) => h === name.toLowerCase())
    const starts = (prefix: string) => norm.findIndex((h) => h.startsWith(prefix.toLowerCase()))

    const idx: ColumnIndex = {
      nombreResidente:     exact("NombreResidente"),
      apellidoResidente:   exact("ApellidoResidente"),
      telefonoResidente:   exact("TelefonoResidente"),
      emailResidente:      exact("EmailResidente"),
      documentoResidente:  exact("DocumentoResidente"),
      nombreResponsable:   exact("NombreResponsable"),
      apellidoResponsable: exact("ApellidoResponsable"),
      emailResponsable:    exact("EmailResponsable"),
      telefonoResponsable: exact("TeléfonoResponsable"),
      dni:                 exact("DNI"),
      cuit:                exact("CUIT"),
      fechaIngreso:        starts("fecha de ingreso"),
      fechaEgreso:         starts("fecha de egreso"),
    }

    const required: (keyof ColumnIndex)[] = ["documentoResidente", "nombreResidente"]
    const missing = required.filter((k) => idx[k] === -1)
    if (missing.length > 0) {
      throw new Error(`Senior Home: missing required columns: ${missing.join(", ")}`)
    }

    return idx
  }

  // ─── Row mapping ──────────────────────────────────────────────────────────

  /**
   * Converts a single raw row into a structured {@link LoadableRow}.
   *
   * The responsible node is included only if the row carries at least one
   * usable document (CUIT or DNI). The relationship is unconditionally
   * declared — the service will skip it if the responsible isn't loaded.
   */
  private mapRow(row: unknown[], idx: ColumnIndex, rowNumber: number, loadedAt: string): LoadableRow {
    const residentDoc = digitsOnly(row[idx.documentoResidente])

    const residentNode: LoadableNode = {
      document: residentDoc,
      businessName: `${cellAsString(row[idx.nombreResidente])} ${cellAsString(row[idx.apellidoResidente])}`.trim(),
      source: SOURCE_RESIDENT,
      attributes: buildAttributes({
        phone:     cellAsString(row[idx.telefonoResidente]),
        email:     cellAsString(row[idx.emailResidente]),
        entryDate: cellAsString(row[idx.fechaIngreso]),
        exitDate:  cellAsString(row[idx.fechaEgreso]),
        loadedAt,
      }),
    }

    const nodes: Record<string, LoadableNode> = { [RESIDENT_KEY]: residentNode }
    const relationships: LoadableRow["relationships"] = []

    // Responsible: CUIT preferred, fallback to DNI
    const responsibleDoc = digitsOnly(row[idx.cuit]) || digitsOnly(row[idx.dni])
    if (responsibleDoc) {
      nodes[RESPONSIBLE_KEY] = {
        document: responsibleDoc,
        businessName: `${cellAsString(row[idx.nombreResponsable])} ${cellAsString(row[idx.apellidoResponsable])}`.trim(),
        source: SOURCE_RESPONSIBLE,
        attributes: buildAttributes({
          phone:     cellAsString(row[idx.telefonoResponsable]),
          email:     cellAsString(row[idx.emailResponsable]),
          entryDate: cellAsString(row[idx.fechaIngreso]),
          exitDate:  cellAsString(row[idx.fechaEgreso]),
          loadedAt,
        }),
        // Business rule: the responsible is only relevant if the resident
        // they belong to was loaded. Skip them entirely if the resident
        // wasn't found in Nosis.
        requiresRole: RESIDENT_KEY,
      }
      relationships.push({
        fromKey: RESPONSIBLE_KEY,
        toKey: RESIDENT_KEY,
        relationshipType: RELATIONSHIP_TYPE,
      })
    }

    // Preserve raw data so the writer can replay original columns.
    const raw: Record<string, unknown> = {}
    for (const [key, colIdx] of Object.entries(idx)) {
      raw[key] = colIdx >= 0 ? row[colIdx] : null
    }

    return {
      rowId: String(rowNumber),
      nodes,
      relationships,
      raw,
    }
  }
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface ColumnIndex {
  nombreResidente: number
  apellidoResidente: number
  telefonoResidente: number
  emailResidente: number
  documentoResidente: number
  nombreResponsable: number
  apellidoResponsable: number
  emailResponsable: number
  telefonoResponsable: number
  dni: number
  cuit: number
  fechaIngreso: number
  fechaEgreso: number
}