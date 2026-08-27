import XLSX from "xlsx"
import type { ISourceLoader } from "@ports/interfaces.js"
import type {
  LoadableRow,
  LoadableNode,
  LoadableNodeAttributes,
} from "@domain/entities.js"

// ─── Config ───────────────────────────────────────────────────────────────────

const SOURCE_NAME = "Bolsa"
const MAIN_KEY = "main"

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single Bolsa operation, one per row of the input file.
 * These are collapsed by beneficiary CUIT before writing to the graph.
 */
interface BolsaOperation {
  date: string
  amount: string
  responsibleTaxId: string
  responsibleName: string
  alycSeller: string
}

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
 * Excel date-serial heuristic. Range covers ~1900-01-01 to ~2100, which
 * comfortably includes any "fecha de suscripción" a Bolsa file could carry.
 */
function looksLikeExcelDateSerial(value: unknown): value is number {
  return typeof value === "number" && value >= 1 && value < 73_050
}

/**
 * Converts an Excel serial date (Lotus epoch) to dd/mm/yyyy using UTC to
 * avoid timezone drift. Same conversion used across every loader that
 * touches Excel dates.
 */
function excelSerialToDdMmYyyy(serial: number): string {
  const utcMs = (serial - 25569) * 86400 * 1000
  const date = new Date(utcMs)
  if (isNaN(date.getTime())) return ""
  const day = String(date.getUTCDate()).padStart(2, "0")
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const year = date.getUTCFullYear()
  return `${day}/${month}/${year}`
}

/**
 * Normalises whatever comes in a date cell into dd/mm/yyyy. Returns ""
 * for unparseable input — the row still loads, the date field just
 * carries an empty string in the resulting operation.
 */
function normaliseDate(raw: unknown): string {
  if (raw == null || raw === "") return ""
  if (looksLikeExcelDateSerial(raw)) return excelSerialToDdMmYyyy(raw)

  const s = String(raw).trim()
  if (!s) return ""

  const ddmm = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s)
  if (ddmm) {
    const [, d, m, y] = ddmm
    return `${d!.padStart(2, "0")}/${m!.padStart(2, "0")}/${y}`
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (iso) {
    const y = iso[1]
    const m = iso[2]
    const d = iso[3]
    return `${d!.padStart(2, "0")}/${m!.padStart(2, "0")}/${y}`
  }

  return ""
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
 * Source loader for the "Bolsa" xlsx file.
 *
 * File format (positional — read by column index, not header):
 *   - Column A: FEC.SUB.           → operations[i].date          (normalised)
 *   - Column B: MONTO              → operations[i].amount        (verbatim)
 *   - Column C: CUIT RESPONSABLE   → operations[i].responsibleTaxId
 *   - Column D: NOMBRE RESPONSABLE → operations[i].responsibleName
 *   - Column E: CUIT BENEF.        → document (node key)
 *   - Column F: RAZON BENEF.       → businessName
 *   - Column G: Alyc vendedora     → operations[i].alycSeller
 *
 * Pre-aggregation: rows are collapsed by beneficiary CUIT before yielding
 * LoadableRows. Each yielded row represents one beneficiary and carries
 * the full list of operations that CUIT appeared in.
 *
 * Persistence model: operations are serialised as a JSON string under
 * `customFields.operations`. Neo4j doesn't accept arrays of objects as
 * properties, so JSON is the cleanest way to keep the list on the node.
 * The frontend does `JSON.parse` to render.
 *
 * Reload semantics: because MERGE_BASE_NODE overwrites customFields, a
 * re-run of this loader against an updated Excel replaces the whole
 * operations list for each beneficiary. That matches the user's chosen
 * "overwrite" semantics — the Excel is the source of truth.
 *
 * Category: "to_know" — no Nosis enrichment.
 */
export class BolsaLoader implements ISourceLoader {
  readonly sourceName = SOURCE_NAME

  constructor(private readonly filePath: string) {}

  async load(opts: { startRow: number; count: number }): Promise<LoadableRow[]> {
    const workbook = XLSX.readFile(this.filePath, { cellDates: false })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new Error("Bolsa workbook has no sheets")
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`)

    const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: true,
    })
    if (allRows.length < 2) throw new Error("Bolsa file has no data rows")

    const dataRows = allRows.slice(1) as unknown[][]
    const slice = dataRows.slice(opts.startRow - 1, opts.startRow - 1 + opts.count)
    const loadedAt = todayString()

    return this.groupByBeneficiary(slice, opts.startRow, loadedAt)
  }

  // ─── Row grouping ─────────────────────────────────────────────────────────

  /**
   * Collapses the raw row slice into one LoadableRow per beneficiary CUIT.
   *
   * The Excel row order is preserved inside each operations list — the
   * first operation of a CUIT in the file becomes the first entry.
   *
   * Rows without a valid beneficiary CUIT are silently skipped; the
   * corresponding beneficiary just doesn't get a LoadableRow, so the
   * LoaderService never sees it.
   */
  private groupByBeneficiary(
    rows: unknown[][],
    startRow: number,
    loadedAt: string,
  ): LoadableRow[] {
    interface Bucket {
      businessName: string
      operations: BolsaOperation[]
    }
    const buckets = new Map<string, Bucket>()

    for (const row of rows) {
      const beneficiaryCuit = digitsOnly(row[4])
      if (!beneficiaryCuit) continue

      const rowBusinessName = cellAsString(row[5])
      const operation: BolsaOperation = {
        date:              normaliseDate(row[0]),
        amount:            cellAsString(row[1]),
        responsibleTaxId:  digitsOnly(row[2]),
        responsibleName:   cellAsString(row[3]),
        alycSeller:        cellAsString(row[6]),
      }

      const existing = buckets.get(beneficiaryCuit)
      if (existing) {
        // Prefer a non-empty businessName if this row provides one and the
        // bucket didn't have it yet — the file sometimes leaves it blank on
        // repeated rows.
        if (!existing.businessName && rowBusinessName) {
          existing.businessName = rowBusinessName
        }
        existing.operations.push(operation)
      } else {
        buckets.set(beneficiaryCuit, {
          businessName: rowBusinessName,
          operations: [operation],
        })
      }
    }

    const results: LoadableRow[] = []
    for (const [beneficiaryCuit, bucket] of buckets) {
      const customFields: Record<string, unknown> = {
        operations: JSON.stringify(bucket.operations),
      }

      const mainNode: LoadableNode = {
        document: beneficiaryCuit,
        businessName: bucket.businessName,
        source: SOURCE_NAME,
        category: "to_know",
        attributes: buildAttributes({ loadedAt }, customFields),
      }

      // rowId uses the beneficiary CUIT because there is no single
      // Excel row for it any more — the group represents N rows.
      // Including the op count makes the progress log more informative.
      results.push({
        rowId: `${beneficiaryCuit} (${bucket.operations.length} ops)`,
        nodes: { [MAIN_KEY]: mainNode },
        relationships: [],
        raw: { beneficiaryCuit, businessName: bucket.businessName, opCount: bucket.operations.length },
      })
    }

    // The startRow argument is kept in the signature for API symmetry with
    // the other loaders even though it doesn't drive numbering here.
    void startRow
    return results
  }
}