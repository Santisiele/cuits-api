import { describe, it, expect } from "vitest"
import { summariseLenders } from "@domain/financieraLenders"

function stored(operations: unknown): Record<string, unknown> {
  return { financieraOperations: JSON.stringify(operations) }
}

function op(entityName: string, totalLoan: string, date = "01/04/2026", situation = "1") {
  return { entityName, date, situation, totalLoan }
}

describe("summariseLenders", () => {
  it("lists a single lender with its one month", () => {
    expect(summariseLenders(stored([op("FINARES S.A.", "2638000", "01/04/2026", "3")]))).toEqual([
      { entityName: "FINARES S.A.", months: [{ period: "2026-04", situation: "3", totalLoan: 2638000 }] },
    ])
  })

  it("keeps each month of a lender apart instead of adding them, newest first", () => {
    const lenders = summariseLenders(
      stored([
        op("FINARES S.A.", "1000", "01/04/2026", "1"),
        op("FINARES S.A.", "2500", "01/06/2026", "2"),
        op("FINARES S.A.", "1800", "01/05/2026", "1"),
      ])
    )
    expect(lenders).toEqual([
      {
        entityName: "FINARES S.A.",
        months: [
          { period: "2026-06", situation: "2", totalLoan: 2500 },
          { period: "2026-05", situation: "1", totalLoan: 1800 },
          { period: "2026-04", situation: "1", totalLoan: 1000 },
        ],
      },
    ])
  })

  it("orders months across years", () => {
    const lenders = summariseLenders(stored([op("X", "1", "01/12/2025"), op("X", "2", "01/01/2026")]))
    expect(lenders[0]!.months.map((m) => m.period)).toEqual(["2026-01", "2025-12"])
  })

  it("keeps two operations of the same month as two entries, in stored order", () => {
    const lenders = summariseLenders(
      stored([op("X", "100", "01/04/2026", "1"), op("X", "300", "01/05/2026"), op("X", "200", "01/04/2026", "2")])
    )
    expect(lenders[0]!.months).toEqual([
      { period: "2026-05", situation: "1", totalLoan: 300 },
      { period: "2026-04", situation: "1", totalLoan: 100 },
      { period: "2026-04", situation: "2", totalLoan: 200 },
    ])
  })

  it("puts months without a readable date last, with an empty period", () => {
    const lenders = summariseLenders(
      stored([op("X", "1", ""), op("X", "2", "01/04/2026"), { entityName: "X", totalLoan: "3" }, op("X", "4", "2026-05")])
    )
    expect(lenders[0]!.months).toEqual([
      { period: "2026-04", situation: "1", totalLoan: 2 },
      { period: "", situation: "1", totalLoan: 1 },
      { period: "", situation: "", totalLoan: 3 },
      { period: "", situation: "1", totalLoan: 4 },
    ])
  })

  it("puts first the lender whose newest month is largest, not the largest sum", () => {
    const lenders = summariseLenders(
      stored([
        op("VIEJO", "900", "01/03/2026"),
        op("VIEJO", "100", "01/05/2026"),
        op("NUEVO", "500", "01/05/2026"),
        op("MEDIO", "300", "01/04/2026"),
      ])
    )
    expect(lenders.map((l) => l.entityName)).toEqual(["NUEVO", "MEDIO", "VIEJO"])
  })

  it("breaks a tie in the newest loan by name", () => {
    const lenders = summariseLenders(stored([op("ZETA", "100"), op("ALFA", "100")]))
    expect(lenders.map((l) => l.entityName)).toEqual(["ALFA", "ZETA"])
  })

  it("treats a name with stray spaces as the same lender", () => {
    const lenders = summariseLenders(stored([op("FINARES S.A.", "100"), op("  FINARES S.A. ", "200", "01/05/2026")]))
    expect(lenders.map((l) => [l.entityName, l.months.length])).toEqual([["FINARES S.A.", 2]])
  })

  it("reads large amounts without losing precision", () => {
    expect(summariseLenders(stored([op("X", "465780000")]))[0]!.months[0]!.totalLoan).toBe(465780000)
  })

  it("reads an unreadable, decimal or grouped amount as zero", () => {
    const lenders = summariseLenders(
      stored([op("X", "no informado"), op("X", ""), op("X", "1.500.000"), op("X", "2,5"), { entityName: "X", totalLoan: 7 }])
    )
    expect(lenders[0]!.months.map((m) => m.totalLoan)).toEqual([0, 0, 0, 0, 0])
  })

  it("groups operations with no lender name under an empty name", () => {
    const lenders = summariseLenders(stored([op("", "100"), { totalLoan: "50" }]))
    expect(lenders.map((l) => [l.entityName, l.months.length])).toEqual([["", 2]])
  })

  it("groups a null operation under an empty name", () => {
    const lenders = summariseLenders(stored([null]))
    expect(lenders).toEqual([{ entityName: "", months: [{ period: "", situation: "", totalLoan: 0 }] }])
  })

  it("is empty for a CUIT from another source", () => {
    expect(summariseLenders({ bolsaOperations: "[]" })).toEqual([])
  })

  it("is empty when there are no operations", () => {
    expect(summariseLenders(stored([]))).toEqual([])
  })

  it("does not break the lookup on a corrupt payload", () => {
    expect(summariseLenders({ financieraOperations: "{ not json" })).toEqual([])
  })

  it("ignores a payload that is not a list", () => {
    expect(summariseLenders(stored({ entityName: "X" }))).toEqual([])
  })
})
