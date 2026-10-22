import { describe, it, expect } from "vitest"
import { describeTrustLevelImport, parseTrustLevels } from "@domain/trustLevelImport"

const LEVELS = [
  { value: 1, label: "Inservible" },
  { value: 2, label: "Supera Target" },
  { value: 9, label: "No por actividad" },
]

const HEADER = ["CUIT", "Nombre", "Segmento", "Motivo"]

describe("parseTrustLevels", () => {
  it("finds the level by its name and keeps the reason", () => {
    const parsed = parseTrustLevels(
      [HEADER, ["30-50396126-8", "IBM ARGENTINA SRL", "Supera Target", ""], ["30-11111111-9", "X", "inservible ", "Cerró"]],
      LEVELS
    )
    expect(parsed).toEqual({
      assignments: [
        { taxId: "30503961268", value: 2, label: "Supera Target", reason: "" },
        { taxId: "30111111119", value: 1, label: "Inservible", reason: "Cerró" },
      ],
      skipped: [],
    })
  })

  it("matches the column names in any case and order, with Nivel as Segmento", () => {
    const parsed = parseTrustLevels([["motivo", "NIVEL", "Cuit"], ["", "No por actividad", "33633178009"]], LEVELS)
    expect(parsed.assignments).toEqual([{ taxId: "33633178009", value: 9, label: "No por actividad", reason: "" }])
  })

  it("works without a Motivo column", () => {
    const parsed = parseTrustLevels([["CUIT", "Segmento"], ["33633178009", "Inservible"]], LEVELS)
    expect(parsed.assignments[0]?.reason).toBe("")
  })

  it("skips a bad CUIT and an unknown level with their row", () => {
    const parsed = parseTrustLevels([HEADER, ["123", "A", "Inservible", ""], ["30503961268", "B", "Oro", ""], ["", "", "", ""]], LEVELS)
    expect(parsed.assignments).toEqual([])
    expect(parsed.skipped).toEqual([
      { row: 2, reason: "cuit", value: "123" },
      { row: 3, reason: "level", value: "Oro" },
    ])
  })

  it("treats empty cells as blank", () => {
    const parsed = parseTrustLevels([[null, "CUIT", "Segmento", "Motivo"], [null, "33633178009", "Inservible", null]], LEVELS)
    expect(parsed.assignments).toEqual([{ taxId: "33633178009", value: 1, label: "Inservible", reason: "" }])
  })

  it("keeps the last row when a CUIT repeats", () => {
    const parsed = parseTrustLevels([HEADER, ["30503961268", "", "Inservible", ""], ["30503961268", "", "Supera Target", ""]], LEVELS)
    expect(parsed.assignments).toEqual([{ taxId: "30503961268", value: 2, label: "Supera Target", reason: "" }])
  })

  it("refuses a file without a header or without the needed columns", () => {
    expect(() => parseTrustLevels([], LEVELS)).toThrow("no header row")
    expect(() => parseTrustLevels([["CUIT", "Nombre"]], LEVELS)).toThrow("CUIT and a Segmento")
  })
})

describe("describeTrustLevelImport", () => {
  it("counts per level, with reasons, missing CUITs and skipped rows", () => {
    const lines = describeTrustLevelImport(
      {
        assignments: [
          { taxId: "1", value: 2, label: "Supera Target", reason: "" },
          { taxId: "2", value: 1, label: "Inservible", reason: "Cerró" },
          { taxId: "3", value: 1, label: "Inservible", reason: "" },
        ],
        skipped: [{ row: 4, reason: "level", value: "Oro" }],
      },
      ["30503961268"]
    )
    expect(lines).toEqual([
      "Inservible: 2 CUITs, 1 with a reason",
      "Supera Target: 1 CUITs, 0 with a reason",
      "Not in the graph: 1 (30503961268)",
      "Skipped rows: 1",
      '  row 4: bad level "Oro"',
    ])
  })

  it("says when there is nothing to do", () => {
    expect(describeTrustLevelImport({ assignments: [], skipped: [] }, [])).toEqual([
      "Nothing to assign",
      "Not in the graph: 0",
      "Skipped rows: 0",
    ])
  })
})
