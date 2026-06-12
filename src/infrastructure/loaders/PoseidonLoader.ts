import XLSX from "xlsx"
import type { ISourceLoader } from "@ports/interfaces.js"
import type { LoadableRow } from "@domain/entities.js"

const CUIT_REGEX = /^\d{2}-\d{8}-\d{1}$/

interface PoseidonRow {
  CUIT?: string
  "Nombre completo"?: string
  [key: string]: unknown
}

/**
 * Source loader for the Poseidon xlsx file.
 *
 * File format:
 *   - Single sheet, headers in row 1
 *   - Required columns: "CUIT" (XX-XXXXXXXX-X), "Nombre completo"
 *   - Each row yields exactly ONE node (role "main"), tagged with the
 *     configured source name and no enrichment attributes.
 *
 * Rows with malformed CUITs are silently filtered out before honouring
 * startRow/count, so positional indices refer to *valid* rows only —
 * matching the original loader's behaviour.
 */
export class PoseidonLoader implements ISourceLoader {
  readonly sourceName: string

  constructor(
    private readonly filePath: string,
    sourceName: string = "poseidon"
  ) {
    this.sourceName = sourceName
  }

  async load(opts: { startRow: number; count: number }): Promise<LoadableRow[]> {
    const workbook = XLSX.readFile(this.filePath)
    const firstSheetName = workbook.SheetNames[0]
    if (!firstSheetName) throw new Error("Poseidon workbook has no sheets")

    const sheet = workbook.Sheets[firstSheetName]
    if (!sheet) throw new Error(`Sheet "${firstSheetName}" not found`)

    const rawRows = XLSX.utils.sheet_to_json<PoseidonRow>(sheet)

    const validRows = rawRows.filter((row) =>
      CUIT_REGEX.test(String(row["CUIT"] ?? "").trim())
    )

    const slice = validRows.slice(opts.startRow - 1, opts.startRow - 1 + opts.count)

    return slice.map((row, idx) => {
      const cuit = String(row["CUIT"]).trim()
      const name = String(row["Nombre completo"] ?? "").trim()

      return {
        rowId: String(opts.startRow + idx),
        nodes: {
          main: {
            document: cuit,
            businessName: name,
            source: this.sourceName,
            attributes: {},
          },
        },
        relationships: [],
        raw: { ...row },
      } satisfies LoadableRow
    })
  }
}