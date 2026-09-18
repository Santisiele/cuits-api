import { describe, it, expect } from "vitest"
import { summariseLenders } from "@domain/financieraLenders"

function stored(operations: unknown): Record<string, unknown> {
  return { financieraOperations: JSON.stringify(operations) }
}

function op(entityName: string, totalLoan: string, date = "01/04/2026", situation = "1") {
  return { entityName, date, situation, totalLoan }
}

describe("summariseLenders", () => {
  it("lists a single lender with its one loan", () => {
    expect(summariseLenders(stored([op("FINARES S.A.", "2638000")]))).toEqual([
      { entityName: "FINARES S.A.", operationCount: 1, totalLoan: 2638000 },
    ])
  })

  it("groups the operations taken with the same lender", () => {
    const lenders = summariseLenders(
      stored([op("FINARES S.A.", "1000", "01/04/2026"), op("FINARES S.A.", "2500", "01/05/2026")])
    )
    expect(lenders).toEqual([{ entityName: "FINARES S.A.", operationCount: 2, totalLoan: 3500 }])
  })

  it("keeps different lenders apart", () => {
    const lenders = summariseLenders(stored([op("FINARES S.A.", "1000"), op("MARIAS CAPITAL SA", "2000")]))
    expect(lenders.map((l) => l.entityName).sort()).toEqual(["FINARES S.A.", "MARIAS CAPITAL SA"])
  })

  it("puts the lender owed the most first", () => {
    const lenders = summariseLenders(
      stored([op("CHICA", "100"), op("GRANDE", "900"), op("MEDIANA", "500"), op("CHICA", "50")])
    )
    expect(lenders.map((l) => l.entityName)).toEqual(["GRANDE", "MEDIANA", "CHICA"])
  })

  it("breaks a tie in the total by name", () => {
    const lenders = summariseLenders(stored([op("ZETA", "100"), op("ALFA", "100")]))
    expect(lenders.map((l) => l.entityName)).toEqual(["ALFA", "ZETA"])
  })

  it("treats a name with stray spaces as the same lender", () => {
    const lenders = summariseLenders(stored([op("FINARES S.A.", "100"), op("  FINARES S.A. ", "200")]))
    expect(lenders).toEqual([{ entityName: "FINARES S.A.", operationCount: 2, totalLoan: 300 }])
  })

  it("adds amounts large enough to matter without losing precision", () => {
    const lenders = summariseLenders(stored([op("X", "268515000"), op("X", "465780000")]))
    expect(lenders[0]!.totalLoan).toBe(734295000)
  })

  it("still counts an operation whose amount is unreadable, without adding it", () => {
    const lenders = summariseLenders(stored([op("X", "1000"), op("X", "no informado"), op("X", "")]))
    expect(lenders).toEqual([{ entityName: "X", operationCount: 3, totalLoan: 1000 }])
  })

  it("does not read a decimal or grouped amount as a different number", () => {
    const lenders = summariseLenders(stored([op("X", "1.500.000"), op("X", "2,5")]))
    expect(lenders[0]!.totalLoan).toBe(0)
  })

  it("groups operations with no lender name under an empty name", () => {
    const lenders = summariseLenders(stored([op("", "100"), { totalLoan: "50" }]))
    expect(lenders).toEqual([{ entityName: "", operationCount: 2, totalLoan: 150 }])
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
