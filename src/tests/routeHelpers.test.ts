import { describe, it, expect } from "vitest"
import { parseMaxDepth, DEFAULT_MAX_DEPTH, MAX_ALLOWED_DEPTH } from "@helpers/routeHelpers"

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