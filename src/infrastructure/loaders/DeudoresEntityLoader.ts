import XLSX from "xlsx"
import type { ISourceLoader } from "@ports/interfaces.js"
import type { LoadableRow } from "@domain/entities.js"
import { parseDeudores, deudoresLoadableRows, type ParsedDeudores } from "@domain/deudores.js"

function todayString(): string {
  const d = new Date()
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`
}

export class DeudoresEntityLoader implements ISourceLoader {
  readonly sourceName = "Deudores"

  constructor(private readonly filePath: string) {}

  read(): ParsedDeudores {
    const workbook = XLSX.readFile(this.filePath, { cellDates: false })
    const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""]
    if (!sheet) throw new Error("Deudores workbook has no sheets")

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: true })
    return parseDeudores(rows)
  }

  async load(opts: { startRow: number; count: number }): Promise<LoadableRow[]> {
    const { groups } = this.read()
    const slice = groups.slice(opts.startRow - 1, opts.startRow - 1 + opts.count)
    return deudoresLoadableRows(slice, todayString())
  }
}
