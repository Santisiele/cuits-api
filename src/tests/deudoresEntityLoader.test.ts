import { describe, it, expect, beforeAll, afterAll } from "vitest"
import XLSX from "xlsx"
import fs from "fs"
import os from "os"
import path from "path"
import { DeudoresEntityLoader } from "@infrastructure/loaders/DeudoresEntityLoader"

let dir: string

function workbook(name: string, rows: unknown[][]): string {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Hoja1")
  const file = path.join(dir, name)
  XLSX.writeFile(book, file)
  return file
}

describe("DeudoresEntityLoader", () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "deudores-"))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const rows = [
    ["Fecha", "CUIT", "Situacion", "PrestamoTotal", "Descripcion"],
    [202607, 30645705943, 3, 127000, "BANCO DE COMERCIO S.A."],
    [],
    [202607, 20111111119, 1, 500, "FINARES SA"],
    [202607, 123, 1, 500, "FINARES SA"],
  ]

  it("reads the first sheet, numeric cells included", () => {
    const parsed = new DeudoresEntityLoader(workbook("read.xlsx", rows)).read()
    expect(parsed.groups.map((g) => [g.taxId, g.source, g.operations[0]])).toEqual([
      [
        "30645705943",
        "Deudores Banco de Comercio",
        { entityName: "BANCO DE COMERCIO S.A.", date: "01/07/2026", situation: "3", totalLoan: "127000" },
      ],
      [
        "20111111119",
        "Deudores Finares",
        { entityName: "FINARES SA", date: "01/07/2026", situation: "1", totalLoan: "500" },
      ],
    ])
    expect(parsed.skipped).toEqual([{ row: 5, reason: "cuit" }])
  })

  it("loads the requested slice of groups as rows", async () => {
    const loaded = await new DeudoresEntityLoader(workbook("load.xlsx", rows)).load({ startRow: 2, count: 5 })
    expect(loaded.map((row) => row.nodes["main"]!.source)).toEqual(["Deudores Finares"])
  })

  it("fails on a file without the expected columns", () => {
    const file = path.join(dir, "empty.xlsx")
    fs.writeFileSync(file, "")
    expect(() => new DeudoresEntityLoader(file).read()).toThrow("missing columns")
  })
})
