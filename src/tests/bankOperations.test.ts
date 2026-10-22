import { describe, it, expect } from "vitest"
import {
  isBankSource,
  planBankOperations,
  emptyBankMigrationTally,
  tallyBankMigration,
  describeBankMigration,
} from "@domain/bankOperations"

const COMERCIO = "Deudores Banco de Comercio"
const FINANCIERA = "Deudores por financiera"

function op(entityName: unknown, date = "01/07/2026", totalLoan = "100") {
  return { entityName, date, situation: "1", totalLoan }
}

const bank = op("BANCO DE COMERCIO S.A.")
const lender = op("FINARES S.A.", "01/04/2026")

describe("isBankSource", () => {
  it("accepts a Deudores source named after a bank", () => {
    expect(isBankSource(COMERCIO)).toBe(true)
  })

  it("rejects the financiera source", () => {
    expect(isBankSource(FINANCIERA)).toBe(false)
  })

  it("rejects a source that is not a debtors one", () => {
    expect(isBankSource("Bolsa")).toBe(false)
  })
})

describe("planBankOperations", () => {
  it("moves the operations of the CUIT's bank and keeps the financiera ones", () => {
    const plan = planBankOperations([FINANCIERA, COMERCIO], JSON.stringify([lender, bank]), undefined)
    expect(plan).toEqual({ financiera: [lender], bank: [bank], moved: [bank], bankBefore: 0 })
  })

  it("leaves a bank operation when the CUIT has no source for that bank", () => {
    expect(planBankOperations([FINANCIERA], JSON.stringify([bank]), null)).toBeNull()
  })

  it("leaves a bank operation when the CUIT has another bank's source", () => {
    expect(planBankOperations(["Deudores Banco Galicia"], JSON.stringify([bank]), null)).toBeNull()
  })

  it("moves nothing a second time", () => {
    const first = planBankOperations([COMERCIO], JSON.stringify([lender, bank]), null)!
    const again = planBankOperations([COMERCIO], JSON.stringify(first.financiera), JSON.stringify(first.bank))
    expect(again).toBeNull()
  })

  it("joins the bank operations already stored without repeating one", () => {
    const june = op("BANCO DE COMERCIO S.A.", "01/06/2026")
    const plan = planBankOperations([COMERCIO], JSON.stringify([bank]), JSON.stringify([june, bank]))
    expect(plan).toEqual({ financiera: [], bank: [june, bank], moved: [bank], bankBefore: 2 })
  })

  it("leaves operations without a usable lender name", () => {
    const operations = [op(""), op(42), null, "x", bank]
    const plan = planBankOperations([COMERCIO], JSON.stringify(operations), "")
    expect(plan!.financiera).toEqual([op(""), op(42), null, "x"])
    expect(plan!.moved).toEqual([bank])
  })

  it("touches nothing when the financiera payload is unreadable", () => {
    expect(planBankOperations([COMERCIO], "{ not json", null)).toBeNull()
    expect(planBankOperations([COMERCIO], JSON.stringify({ entityName: "X" }), null)).toBeNull()
    expect(planBankOperations([COMERCIO], 7, null)).toBeNull()
  })

  it("touches nothing when the bank payload is unreadable", () => {
    expect(planBankOperations([COMERCIO], JSON.stringify([bank]), "{ not json")).toBeNull()
  })

  it("has nothing to move without financiera operations", () => {
    expect(planBankOperations([COMERCIO], null, null)).toBeNull()
  })
})

describe("tallyBankMigration and describeBankMigration", () => {
  it("counts every CUIT, the affected ones and the moved operations by lender", () => {
    const tally = emptyBankMigrationTally()
    const nacion = op("BANCO DE LA NACION ARGENTINA")
    const sources = [COMERCIO, "Deudores Banco de la Nacion Argentina"]
    tallyBankMigration(tally, "20111111119", planBankOperations(sources, JSON.stringify([lender, bank, nacion]), null))
    tallyBankMigration(tally, "20222222229", null)
    tallyBankMigration(tally, "20333333339", planBankOperations(sources, JSON.stringify([bank]), JSON.stringify([nacion])))

    expect(describeBankMigration(tally, false)).toEqual([
      "CUITs examined: 3",
      "CUITs affected: 2",
      "Operations to move: 3",
      "  BANCO DE COMERCIO S.A.: 2",
      "  BANCO DE LA NACION ARGENTINA: 1",
      "Sample 20111111119: financieraOperations 3 -> 1, bankOperations 0 -> 2",
      "Sample 20333333339: financieraOperations 1 -> 0, bankOperations 1 -> 2",
    ])
  })

  it("keeps only three samples", () => {
    const tally = emptyBankMigrationTally()
    for (const taxId of ["1", "2", "3", "4"]) {
      tallyBankMigration(tally, taxId, planBankOperations([COMERCIO], JSON.stringify([bank]), null))
    }
    expect(tally.samples.map((sample) => sample.taxId)).toEqual(["1", "2", "3"])
    expect(tally.moved).toBe(4)
  })

  it("says the operations were moved once applied", () => {
    expect(describeBankMigration(emptyBankMigrationTally(), true)).toEqual([
      "CUITs examined: 0",
      "CUITs affected: 0",
      "Operations moved: 0",
    ])
  })
})
