import { describe, it, expect } from "vitest"
import { parseMaxDepth, parseLevel, rangeEndsBeforeItStarts, DEFAULT_MAX_DEPTH, MAX_ALLOWED_DEPTH } from "@helpers/routeHelpers"

describe("parseMaxDepth", () => {
  describe("default behavior", () => {
    it("returns DEFAULT_MAX_DEPTH when value is undefined", () => {
      expect(parseMaxDepth(undefined)).toBe(DEFAULT_MAX_DEPTH)
    })

    it("returns DEFAULT_MAX_DEPTH when value is empty string", () => {
      expect(parseMaxDepth("")).toBe(DEFAULT_MAX_DEPTH)
    })
  })

  describe("valid values", () => {
    it("returns 1 for '1'", () => {
      expect(parseMaxDepth("1")).toBe(1)
    })

    it("returns MAX_ALLOWED_DEPTH for its string value", () => {
      expect(parseMaxDepth(String(MAX_ALLOWED_DEPTH))).toBe(MAX_ALLOWED_DEPTH)
    })

    it("returns 5 for '5'", () => {
      expect(parseMaxDepth("5")).toBe(5)
    })

    it("returns the correct integer for a valid number string", () => {
      expect(parseMaxDepth("3")).toBe(3)
    })
  })

  describe("invalid values", () => {
    it("returns null for '0'", () => {
      expect(parseMaxDepth("0")).toBeNull()
    })

    it("returns null for negative numbers", () => {
      expect(parseMaxDepth("-1")).toBeNull()
    })

    it("returns null for values above MAX_ALLOWED_DEPTH", () => {
      expect(parseMaxDepth(String(MAX_ALLOWED_DEPTH + 1))).toBeNull()
    })

    it("returns null for non-numeric strings", () => {
      expect(parseMaxDepth("abc")).toBeNull()
    })

    it("returns null for 'NaN'", () => {
      expect(parseMaxDepth("NaN")).toBeNull()
    })

    it("returns null for float strings", () => {
      expect(parseMaxDepth("2.5")).toBeNull()
    })
  })

  describe("constants", () => {
    it("DEFAULT_MAX_DEPTH is 3", () => {
      expect(DEFAULT_MAX_DEPTH).toBe(3)
    })

    it("MAX_ALLOWED_DEPTH is 10", () => {
      expect(MAX_ALLOWED_DEPTH).toBe(10)
    })
  })
})

describe("rangeEndsBeforeItStarts", () => {
  it("rejects an end date before the start date in the same year", () => {
    expect(rangeEndsBeforeItStarts("20/12/2026", "05/01/2026")).toBe(true)
  })

  it("accepts a range that wraps into the next year", () => {
    expect(rangeEndsBeforeItStarts("20/12/2026", "05/01/2027")).toBe(false)
  })

  it("accepts a plain forward range", () => {
    expect(rangeEndsBeforeItStarts("01/03/2026", "31/03/2026")).toBe(false)
  })

  it("accepts the same day on both ends", () => {
    expect(rangeEndsBeforeItStarts("17/09/2026", "17/09/2026")).toBe(false)
  })

  it("accepts dashes as separators", () => {
    expect(rangeEndsBeforeItStarts("20-12-2026", "05-01-2026")).toBe(true)
  })

  it("does not judge a range whose start omits the year", () => {
    expect(rangeEndsBeforeItStarts("20/12", "05/01/2026")).toBe(false)
  })

  it("does not judge a range whose end omits the year", () => {
    expect(rangeEndsBeforeItStarts("20/12/2026", "05/01")).toBe(false)
  })

  it("does not judge an unparseable range", () => {
    expect(rangeEndsBeforeItStarts("hola", "chau")).toBe(false)
  })
})

describe("parseLevel", () => {
  it("reads a whole number", () => {
    expect(parseLevel("3")).toBe(3)
  })

  it("reads zero, leaving the reserved check to the service", () => {
    expect(parseLevel("0")).toBe(0)
  })

  it("tolerates surrounding spaces", () => {
    expect(parseLevel(" 4 ")).toBe(4)
  })

  it("refuses a missing value", () => {
    expect(parseLevel(undefined)).toBeNull()
  })

  it("refuses an empty string rather than reading it as zero", () => {
    expect(parseLevel("")).toBeNull()
  })

  it("refuses a decimal", () => {
    expect(parseLevel("2.5")).toBeNull()
  })

  it("refuses a negative number", () => {
    expect(parseLevel("-1")).toBeNull()
  })

  it("refuses text", () => {
    expect(parseLevel("alto")).toBeNull()
  })
})
