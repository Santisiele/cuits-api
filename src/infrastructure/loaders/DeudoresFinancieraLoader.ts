import XLSX from "xlsx"
import type { ISourceLoader } from "@ports/interfaces.js"
import type {
  LoadableRow,
  LoadableNode,
  LoadableNodeAttributes,
} from "@domain/entities.js"

// ─── Config ───────────────────────────────────────────────────────────────────

const SOURCE_NAME = "Deudores por financiera"
const MAIN_KEY = "main"

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single deudor operation, one per row of the input file.
 * These are collapsed by debtor CUIT before writing to the graph.
 */
interface DeudorOperation {
  entityName: string
  date: string
  situation: string
  totalLoan: string
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
 * Normalises a yyyymm period cell into a dd/mm/yyyy date, forcing the
 * day to 01. The source file only carries year+month (e.g. 202604 for
 * April 2026), so the first of the month is the canonical anchor.
 *
 * Accepts:
 *   - Number 202604 (Excel numeric cell)
 *   - String "202604"
 *   - Anything with 6 digits somewhere ("2026/04", "2026-04") → digits only
 *
 * Returns "" for anything unparseable — the row still loads, its
 * operation just has an empty date field.
 */
function normalisePeriodDate(raw: unknown): string {
  const digits = digitsOnly(raw)
  if (digits.length !== 6) return ""

  const year  = digits.slice(0, 4)
  const month = digits.slice(4, 6)
  const m = Number(month)
  if (!Number.isFinite(m) || m < 1 || m > 12) return ""

  return `01/${month}/${year}`
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
 * Source loader for the "Deudores por financiera" xlsx file.
 *
 * File format (positional — read by column index, not header):
 *   - Column A: Codigo           → IGNORED
 *   - Column B: Descripcion      → operations[i].entityName (lender name)
 *   - Column C: CUIT             → document (node key)
 *   - Column D: Denominacion     → businessName
 *   - Column E: Fecha (yyyymm)   → operations[i].date (normalised to 01/mm/yyyy)
 *   - Column F: Situacion        → operations[i].situation (1..5)
 *   - Column G: PrestamoTotal    → operations[i].totalLoan (verbatim)
 *   - Column H: Actividad        → IGNORED
 *   - Column I: Baja             → IGNORED
 *
 * Pre-aggregation: rows are collapsed by debtor CUIT before yielding
 * LoadableRows. Each yielded row represents one debtor and carries the
 * full list of operations that CUIT appeared in.
 *
 * Same persistence and reload semantics as BolsaLoader — operations are
 * serialised as a JSON string under `customFields.operations`, and
 * re-running the loader against an updated Excel replaces the whole
 * operations list per debtor.
 *
 * Category: "to_know" — no Nosis enrichment.
 */
export class DeudoresLoader implements ISourceLoader {
  readonly sourceName = SOURCE_NAME

  constructor(private readonly filePath: string) {}

  async load(opts: { startRow: number; count: number }): Promise<LoadableRow[]> {
    const workbook = XLSX.readFile(this.filePath, { cellDates: false })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new Error("Deudores workbook has no sheets")
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found`)

    const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: true,
    })
    if (allRows.length < 2) throw new Error("Deudores file has no data rows")

    const dataRows = allRows.slice(1) as unknown[][]
    const slice = dataRows.slice(opts.startRow - 1, opts.startRow - 1 + opts.count)
    const loadedAt = todayString()

    return this.groupByDebtor(slice, opts.startRow, loadedAt)
  }

  // ─── Row grouping ─────────────────────────────────────────────────────────

  /**
   * Collapses the raw row slice into one LoadableRow per debtor CUIT.
   *
   * The Excel row order is preserved inside each operations list — the
   * first operation of a CUIT in the file becomes the first entry.
   *
   * Rows without a valid debtor CUIT are silently skipped.
   */
  private groupByDebtor(
    rows: unknown[][],
    startRow: number,
    loadedAt: string,
  ): LoadableRow[] {
    interface Bucket {
      businessName: string
      operations: DeudorOperation[]
    }
    const buckets = new Map<string, Bucket>()

    for (const row of rows) {
      const debtorCuit = digitsOnly(row[2])
      if (!debtorCuit) continue

      const rowBusinessName = cellAsString(row[3])
      const operation: DeudorOperation = {
        entityName: cellAsString(row[1]),
        date:       normalisePeriodDate(row[4]),
        situation:  cellAsString(row[5]),
        totalLoan:  cellAsString(row[6]),
      }

      const existing = buckets.get(debtorCuit)
      if (existing) {
        // Prefer a non-empty businessName if this row provides one and the
        // bucket didn't have it yet — the file sometimes leaves it blank on
        // repeated rows.
        if (!existing.businessName && rowBusinessName) {
          existing.businessName = rowBusinessName
        }
        existing.operations.push(operation)
      } else {
        buckets.set(debtorCuit, {
          businessName: rowBusinessName,
          operations: [operation],
        })
      }
    }

    const results: LoadableRow[] = []
    for (const [debtorCuit, bucket] of buckets) {
      const customFields: Record<string, unknown> = {
        operations: JSON.stringify(bucket.operations),
      }

      const mainNode: LoadableNode = {
        document: debtorCuit,
        businessName: bucket.businessName,
        source: SOURCE_NAME,
        category: "to_know",
        attributes: buildAttributes({ loadedAt }, customFields),
      }

      results.push({
        rowId: `${debtorCuit} (${bucket.operations.length} ops)`,
        nodes: { [MAIN_KEY]: mainNode },
        relationships: [],
        raw: { debtorCuit, businessName: bucket.businessName, opCount: bucket.operations.length },
      })
    }

    void startRow
    return results
  }
}