import XLSX from "xlsx"
import fs from "fs"
import type { ILoadOutputWriter } from "@ports/interfaces.js"
import type { RowLoadOutcome } from "@domain/entities.js"

// ─── Constants ────────────────────────────────────────────────────────────────

const OUTPUT_HEADER = [
  "Fecha de carga",
  "NombreResidente",
  "ApellidoResidente",
  "DocumentoResidente",
  "CUIT Residente (Nosis)",
  "NombreResponsable",
  "ApellidoResponsable",
  "DNI",
  "CUIT Responsable",
  "CUIT Responsable (Nosis)",
  "Estado",
  "Notas",
] as const

const STATUS_LABEL: Record<RowLoadOutcome["overall"], string> = {
  all_loaded: "Residente y responsable cargados",
  partial:    "Solo residente cargado",
  none:       "Nada cargado",
}

const STATUS_FILL: Record<RowLoadOutcome["overall"], string> = {
  all_loaded: "FFFFFF00", // yellow
  partial:    "FF00FFFF", // cyan
  none:       "FFFF0000", // red
}

const RESIDENT_KEY = "resident"
const RESPONSIBLE_KEY = "responsible"

// ─── Writer ───────────────────────────────────────────────────────────────────

/**
 * Output writer specific to the Senior Home flow.
 *
 * Appends one row per processed input row to the configured xlsx file,
 * colour-coded by overall outcome (yellow / cyan / red). If the file
 * already exists, previous rows are preserved (so repeated partial runs
 * accumulate history).
 *
 * Limitation: SheetJS Community Edition cannot preserve cell styles when
 * round-tripping (read → write) an .xlsx file. Therefore the colours of
 * rows from previous runs are lost on each invocation; only the rows
 * appended by the current run are guaranteed to be coloured. Switching
 * to `exceljs` would fix this if it ever becomes important.
 */
export class SeniorHomeXlsxWriter implements ILoadOutputWriter {
  constructor(private readonly outputPath: string) {}

  async write(outcomes: RowLoadOutcome[]): Promise<void> {
    const existing = this.readExisting()
    const today = this.todayString()

    const newRows = outcomes.map((outcome) => this.outcomeToRow(outcome, today))

    const aoa: unknown[][] = [
      [...OUTPUT_HEADER],
      ...existing,
      ...newRows,
    ]

    const sheet = XLSX.utils.aoa_to_sheet(aoa)
    this.applyColours(sheet, outcomes, existing.length)

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, sheet, "Carga")
    XLSX.writeFile(wb, this.outputPath, { cellStyles: true })
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private readExisting(): unknown[][] {
    if (!fs.existsSync(this.outputPath)) return []
    try {
      const wb = XLSX.readFile(this.outputPath, { cellStyles: true })
      const sheetName = wb.SheetNames[0]
      if (!sheetName) return []
      const sheet = wb.Sheets[sheetName]
      if (!sheet) return []
      const all = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })
      return all.slice(1) // drop header
    } catch {
      return []
    }
  }

  private outcomeToRow(outcome: RowLoadOutcome, today: string): unknown[] {
    const raw = outcome.row.raw

    const residentTaxId = outcome.nodes.find((n) => n.roleKey === RESIDENT_KEY)?.resolvedTaxId ?? ""
    const responsibleTaxId = outcome.nodes.find((n) => n.roleKey === RESPONSIBLE_KEY)?.resolvedTaxId ?? ""

    const notes = outcome.nodes
      .filter((n) => n.notes)
      .map((n) => `[${n.roleKey}] ${n.notes}`)
      .join(" | ")

    return [
      today,
      String(raw["nombreResidente"]     ?? ""),
      String(raw["apellidoResidente"]   ?? ""),
      String(raw["documentoResidente"]  ?? ""),
      residentTaxId,
      String(raw["nombreResponsable"]   ?? ""),
      String(raw["apellidoResponsable"] ?? ""),
      String(raw["dni"]                 ?? ""),
      String(raw["cuit"]                ?? ""),
      responsibleTaxId,
      STATUS_LABEL[outcome.overall],
      notes,
    ]
  }

  /**
   * Applies background colours to every cell of the newly appended rows.
   * Header occupies row 0, existing rows occupy 1..existingCount, new
   * rows start at row (1 + existingCount).
   */
  private applyColours(
    sheet: XLSX.WorkSheet,
    outcomes: RowLoadOutcome[],
    existingCount: number
  ): void {
    const firstNewRowIdx = 1 + existingCount
    outcomes.forEach((outcome, i) => {
      const rowIdx = firstNewRowIdx + i
      for (let col = 0; col < OUTPUT_HEADER.length; col++) {
        const cellRef = XLSX.utils.encode_cell({ r: rowIdx, c: col })
        const cell = sheet[cellRef]
        if (!cell) continue
        cell.s = {
          fill: { patternType: "solid", fgColor: { rgb: STATUS_FILL[outcome.overall] } },
        }
      }
    })
  }

  private todayString(): string {
    const d = new Date()
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`
  }
}