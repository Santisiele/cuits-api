import { describe, it, expect } from "vitest"
import {
  changedFields,
  cleanText,
  isRealDate,
  isTooLong,
  isValidBirthday,
  isValidCrmCuit,
  isValidCrmId,
  removalOutcome,
  shouldMarkNosisPending,
  uniqueTaxIds,
} from "@domain/crm"

const NEVER_SEEN = { exists: false, inCrm: false, archived: false, nosisSearched: false, inKnownSource: false }

describe("shouldMarkNosisPending", () => {
  it("marks a CUIT that was not in the graph", () => {
    expect(shouldMarkNosisPending(NEVER_SEEN)).toBe(true)
  })

  it("marks one that exists but was never searched and is in no known source", () => {
    expect(shouldMarkNosisPending({ ...NEVER_SEEN, exists: true })).toBe(true)
  })

  it("leaves one that was already searched", () => {
    expect(shouldMarkNosisPending({ ...NEVER_SEEN, exists: true, nosisSearched: true })).toBe(false)
  })

  it("leaves one that a known source already brought", () => {
    expect(shouldMarkNosisPending({ ...NEVER_SEEN, exists: true, inKnownSource: true })).toBe(false)
  })
})

describe("removalOutcome", () => {
  it("archives a company with CRM history, whatever else holds it", () => {
    expect(removalOutcome({ hasHistory: true, hasOtherSource: false, relatedToBase: false })).toBe("archived")
  })

  it("deletes one left with nothing", () => {
    expect(removalOutcome({ hasHistory: false, hasOtherSource: false, relatedToBase: false })).toBe("deleted")
  })

  it("only unlinks one that another source still holds", () => {
    expect(removalOutcome({ hasHistory: false, hasOtherSource: true, relatedToBase: false })).toBe("unlinked")
  })

  it("only unlinks one related to the base", () => {
    expect(removalOutcome({ hasHistory: false, hasOtherSource: false, relatedToBase: true })).toBe("unlinked")
  })
})

describe("validation", () => {
  it("accepts an 11-digit CUIT only", () => {
    expect(isValidCrmCuit("30712345678")).toBe(true)
    expect(isValidCrmCuit("30-71234567-8")).toBe(false)
    expect(isValidCrmCuit(30712345678)).toBe(false)
  })

  it("accepts a UUID as an id", () => {
    expect(isValidCrmId("3f2b8c1e-9a4d-4c7b-8e1f-0a2b3c4d5e6f")).toBe(true)
    expect(isValidCrmId("nope")).toBe(false)
    expect(isValidCrmId(4)).toBe(false)
  })

  it("accepts real calendar days only", () => {
    expect(isRealDate(2024, 2, 29)).toBe(true)
    expect(isRealDate(2026, 2, 29)).toBe(false)
    expect(isRealDate(2026, 13, 1)).toBe(false)
  })

  it("reads birthdays as dd/mm/yyyy", () => {
    expect(isValidBirthday("06/05/1980")).toBe(true)
    expect(isValidBirthday("31/04/1980")).toBe(false)
    expect(isValidBirthday("1980-05-06")).toBe(false)
  })

  it("trims text and treats blank as missing", () => {
    expect(cleanText("  ACME  ")).toBe("ACME")
    expect(cleanText("   ")).toBeNull()
    expect(cleanText(4)).toBeNull()
  })

  it("measures length", () => {
    expect(isTooLong("abc", 2)).toBe(true)
    expect(isTooLong("ab", 2)).toBe(false)
    expect(isTooLong(null, 2)).toBe(false)
  })

  it("dedupes CUIT lists and refuses a bad one", () => {
    expect(uniqueTaxIds(["30712345678", "30712345678"])).toEqual(["30712345678"])
    expect(uniqueTaxIds(["30712345678", "x"])).toBeNull()
    expect(uniqueTaxIds("30712345678")).toBeNull()
    expect(uniqueTaxIds([])).toEqual([])
  })
})

describe("changedFields", () => {
  it("keeps only what changed, with missing values as null", () => {
    expect(changedFields({ a: 1, b: "x", c: ["1"] }, { a: 1, b: "y", c: ["1"], d: "new" })).toEqual({
      before: { b: "x", d: null },
      after: { b: "y", d: "new" },
    })
  })

  it("records a value cleared to null", () => {
    expect(changedFields({ a: "x" }, { a: null })).toEqual({ before: { a: "x" }, after: { a: null } })
  })
})
