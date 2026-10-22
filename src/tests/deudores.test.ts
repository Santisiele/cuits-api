import { describe, it, expect } from "vitest"
import {
  cleanEntityName,
  deudoresSourceName,
  parseDeudores,
  summariseDeudoresSources,
  describeDeudoresDryRun,
  deudoresLoadableRows,
} from "@domain/deudores"

const HEADER = ["Fecha", "CUIT", "Situacion", "PrestamoTotal", "Descripcion"]

function file(...rows: unknown[][]): unknown[][] {
  return [HEADER, ...rows]
}

describe("cleanEntityName", () => {
  it("drops the legal suffix and title-cases with lowercase connectors", () => {
    expect(cleanEntityName("BANCO DE COMERCIO S.A.")).toBe("Banco de Comercio")
  })

  it.each([
    ["FINARES SA", "Finares"],
    ["FINARES S.A", "Finares"],
    ["FINARES S. A.", "Finares"],
    ["FINARES S.A.U.", "Finares"],
    ["FINARES SAU", "Finares"],
    ["FINARES S.R.L.", "Finares"],
    ["FINARES SRL", "Finares"],
    ["FINARES S.A.S.", "Finares"],
    ["FINARES SAS", "Finares"],
    ["FINARES S.C.A.", "Finares"],
    ["FINARES SCA", "Finares"],
    ["finares s.a.", "Finares"],
    ["FINARES, S.A.", "Finares"],
  ])("removes the suffix of %s", (raw, clean) => {
    expect(cleanEntityName(raw)).toBe(clean)
  })

  it("trims and collapses spaces", () => {
    expect(cleanEntityName("  BANCO   DE  LA   PAMPA  ")).toBe("Banco de la Pampa")
  })

  it("keeps every connector lowercase after the first word", () => {
    expect(cleanEntityName("BANCO DEL SOL Y LAS LOMAS E LOS ANDES EL ALTO")).toBe(
      "Banco del Sol y las Lomas e los Andes el Alto"
    )
  })

  it("capitalises a connector that opens the name", () => {
    expect(cleanEntityName("LA SEGUNDA COOPERATIVA")).toBe("La Segunda Cooperativa")
  })

  it("keeps accents while changing case", () => {
    expect(cleanEntityName("ÑANDÚ CRÉDITOS SRL")).toBe("Ñandú Créditos")
  })

  it("does not cut a word that merely ends like a suffix", () => {
    expect(cleanEntityName("CASAS")).toBe("Casas")
    expect(cleanEntityName("PRESTAMOS PARA CASAS")).toBe("Prestamos Para Casas")
  })

  it("is empty for a blank name", () => {
    expect(cleanEntityName("   ")).toBe("")
  })
})

describe("deudoresSourceName", () => {
  it("prefixes the clean entity name", () => {
    expect(deudoresSourceName("BANCO DE COMERCIO S.A.")).toBe("Deudores Banco de Comercio")
  })
})

describe("parseDeudores", () => {
  it("turns a row into an operation of its entity's source", () => {
    const parsed = parseDeudores(file([202607, 30645705943, 3, 127000, "BANCO DE COMERCIO S.A."]))
    expect(parsed).toEqual({
      groups: [
        {
          taxId: "30645705943",
          businessName: "",
          source: "Deudores Banco de Comercio",
          operations: [
            { entityName: "BANCO DE COMERCIO S.A.", date: "01/07/2026", situation: "3", totalLoan: "127000" },
          ],
        },
      ],
      skipped: [],
    })
  })

  it("finds the columns by name in any order, case and accents", () => {
    const parsed = parseDeudores([
      ["descripción", "PRESTAMO TOTAL", "Situación", "cuit", " FECHA "],
      ["FINARES SA", "500", "1", "20-11111111-9", "202605"],
    ])
    expect(parsed.groups).toEqual([
      {
        taxId: "20111111119",
        businessName: "",
        source: "Deudores Finares",
        operations: [{ entityName: "FINARES SA", date: "01/05/2026", situation: "1", totalLoan: "500" }],
      },
    ])
  })

  it("reads the bank file as it really comes, with NumeroIdentificacion, Nombre and Banco", () => {
    const parsed = parseDeudores([
      ["Fecha", "NumeroIdentificacion", "Situacion", "PrestamoTotal", "Nombre", "Banco"],
      [202607, 20054564946, 1, 33000, "DIRECTOR  JAIME", "BANCO DE COMERCIO S.A."],
      [202607, 20054564946, 2, 1000, "", "BANCO DE COMERCIO S.A."],
    ])
    expect(parsed.skipped).toEqual([])
    expect(parsed.groups).toEqual([
      {
        taxId: "20054564946",
        businessName: "DIRECTOR JAIME",
        source: "Deudores Banco de Comercio",
        operations: [
          { entityName: "BANCO DE COMERCIO S.A.", date: "01/07/2026", situation: "1", totalLoan: "33000" },
          { entityName: "BANCO DE COMERCIO S.A.", date: "01/07/2026", situation: "2", totalLoan: "1000" },
        ],
      },
    ])
  })

  it("ignores columns it does not use", () => {
    const parsed = parseDeudores([
      ["Codigo", ...HEADER],
      ["X1", "202605", "20111111119", "1", "500", "FINARES SA"],
    ])
    expect(parsed.groups).toHaveLength(1)
  })

  it("groups the rows of a CUIT with the same entity", () => {
    const parsed = parseDeudores(
      file(
        ["202606", "20111111119", "1", "100", "FINARES SA"],
        ["202607", "20111111119", "2", "200", "FINARES S.A."]
      )
    )
    expect(parsed.groups).toHaveLength(1)
    expect(parsed.groups[0]!.operations.map((o) => o.entityName)).toEqual(["FINARES SA", "FINARES S.A."])
  })

  it("splits one file into a source per entity", () => {
    const parsed = parseDeudores(
      file(
        ["202607", "20111111119", "1", "100", "FINARES SA"],
        ["202607", "20111111119", "1", "300", "BANCO DE COMERCIO S.A."],
        ["202607", "20222222229", "1", "200", "FINARES SA"]
      )
    )
    expect(parsed.groups.map((g) => [g.taxId, g.source])).toEqual([
      ["20111111119", "Deudores Finares"],
      ["20111111119", "Deudores Banco de Comercio"],
      ["20222222229", "Deudores Finares"],
    ])
  })

  it("collapses the spaces of the entity as written", () => {
    const parsed = parseDeudores(file(["202607", "20111111119", "1", "100", "  BANCO  DE COMERCIO S.A. "]))
    expect(parsed.groups[0]!.operations[0]!.entityName).toBe("BANCO DE COMERCIO S.A.")
  })

  it("skips silently a fully blank row", () => {
    expect(parseDeudores(file(["", "", "", "", ""], [null, null, null, null, null]))).toEqual({
      groups: [],
      skipped: [],
    })
  })

  it("keeps any situation the entity reports, like 11", () => {
    const parsed = parseDeudores(file(["202607", "30505607925", "11", "250312000", "BANCO DE COMERCIO S.A."]))
    expect(parsed.skipped).toEqual([])
    expect(parsed.groups[0]?.operations[0]?.situation).toBe("11")
  })

  it.each([
    [["202607", "2011111111", "1", "100", "FINARES SA"], "cuit"],
    [["202607", "", "1", "100", "FINARES SA"], "cuit"],
    [["2026-7", "20111111119", "1", "100", "FINARES SA"], "period"],
    [["202613", "20111111119", "1", "100", "FINARES SA"], "period"],
    [["202600", "20111111119", "1", "100", "FINARES SA"], "period"],
    [["", "20111111119", "1", "100", "FINARES SA"], "period"],
    [["202607", "20111111119", "0", "100", "FINARES SA"], "situation"],
    [["202607", "20111111119", "A", "100", "FINARES SA"], "situation"],
    [["202607", "20111111119", "", "100", "FINARES SA"], "situation"],
    [["202607", "20111111119", "1", "1.500", "FINARES SA"], "amount"],
    [["202607", "20111111119", "1", "", "FINARES SA"], "amount"],
    [["202607", "20111111119", "1", "100", "   "], "entity"],
  ])("skips %j as a bad %s, with its sheet row", (row, reason) => {
    expect(parseDeudores(file(row as unknown[]))).toEqual({ groups: [], skipped: [{ row: 2, reason }] })
  })

  it("numbers skipped rows as the sheet shows them", () => {
    const parsed = parseDeudores(
      file(["202607", "20111111119", "1", "100", "FINARES SA"], ["202607", "bad", "1", "100", "FINARES SA"])
    )
    expect(parsed.skipped).toEqual([{ row: 3, reason: "cuit" }])
  })

  it("fails on a file without a header", () => {
    expect(() => parseDeudores([])).toThrow("no header row")
  })

  it("names every missing column", () => {
    expect(() => parseDeudores([["Fecha", "CUIT", "Situacion"]])).toThrow(
      "missing columns: prestamototal, banco or descripcion"
    )
  })

  it("does not take an empty header cell for a column", () => {
    expect(() => parseDeudores([[null, "CUIT", "Situacion", "PrestamoTotal", "Descripcion"]])).toThrow(
      "missing columns: fecha"
    )
  })
})

describe("summariseDeudoresSources", () => {
  const parsed = parseDeudores(
    file(
      ["202607", "20111111119", "1", "100", "FINARES SA"],
      ["202606", "20111111119", "1", "100", "FINARES SA"],
      ["202607", "20222222229", "1", "200", "FINARES SA"],
      ["202607", "20111111119", "1", "300", "BANCO DE COMERCIO S.A."]
    )
  )

  it("counts CUITs, operations and periods per source, sorted by source", () => {
    expect(summariseDeudoresSources(parsed.groups)).toEqual([
      { source: "Deudores Banco de Comercio", cuitCount: 1, operationCount: 1, periods: ["2026-07"] },
      { source: "Deudores Finares", cuitCount: 2, operationCount: 3, periods: ["2026-06", "2026-07"] },
    ])
  })

  it("is empty with nothing to load", () => {
    expect(summariseDeudoresSources([])).toEqual([])
  })
})

describe("describeDeudoresDryRun", () => {
  it("prints a line per source and no skipped rows", () => {
    const parsed = parseDeudores(file(["202607", "20111111119", "1", "100", "FINARES SA"]))
    expect(describeDeudoresDryRun(parsed)).toEqual([
      "Deudores Finares: 1 CUITs, 1 operations, periods 2026-07",
      "Skipped rows: none",
    ])
  })

  it("groups skipped rows by reason", () => {
    const parsed = parseDeudores(
      file(
        ["202607", "bad", "1", "100", "FINARES SA"],
        ["999999", "20111111119", "1", "100", "FINARES SA"],
        ["202607", "bad", "1", "100", "FINARES SA"]
      )
    )
    expect(describeDeudoresDryRun(parsed)).toEqual([
      "No rows to load",
      "Skipped rows: 3",
      "  bad cuit: 2 (rows 2, 4)",
      "  bad period: 1 (rows 3)",
    ])
  })

  it("lists only the first ten rows of a reason", () => {
    const bad = Array.from({ length: 12 }, () => ["202607", "bad", "1", "100", "FINARES SA"])
    expect(describeDeudoresDryRun(parseDeudores(file(...bad)))).toContain(
      "  bad cuit: 12 (rows 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 2 more)"
    )
  })
})

describe("deudoresLoadableRows", () => {
  it("writes the name the bank file brings", () => {
    const { groups } = parseDeudores([
      ["Fecha", "NumeroIdentificacion", "Situacion", "PrestamoTotal", "Nombre", "Banco"],
      ["202607", "20054564946", "1", "33000", "DIRECTOR JAIME", "BANCO DE COMERCIO S.A."],
    ])
    expect(deudoresLoadableRows(groups, "22/10/2026")[0]?.nodes["main"]?.businessName).toBe("DIRECTOR JAIME")
  })

  it("writes each group as a to_know node with no name and its operations as JSON", () => {
    const { groups } = parseDeudores(file(["202607", "20111111119", "3", "127000", "BANCO DE COMERCIO S.A."]))
    expect(deudoresLoadableRows(groups, "22/10/2026")).toEqual([
      {
        rowId: "20111111119 Deudores Banco de Comercio (1 ops)",
        nodes: {
          main: {
            document: "20111111119",
            businessName: "",
            source: "Deudores Banco de Comercio",
            category: "to_know",
            attributes: {
              loadedAt: "22/10/2026",
              customFields: {
                bankOperations: JSON.stringify([
                  { entityName: "BANCO DE COMERCIO S.A.", date: "01/07/2026", situation: "3", totalLoan: "127000" },
                ]),
              },
            },
          },
        },
        relationships: [],
        raw: { taxId: "20111111119", source: "Deudores Banco de Comercio", opCount: 1 },
      },
    ])
  })
})
