import { describe, it, expect, vi, beforeEach } from "vitest"
import { filterValidCuits, loadCuitsIntoNeo4j, type CuitRecord } from "@helpers/cuitLoader"
import type { Session } from "neo4j-driver"

// ─── filterValidCuits ─────────────────────────────────────────────────────────

describe("filterValidCuits", () => {
  const SOURCE = "csv-test"

  // ── Valid formats ───────────────────────────────────────────────────────────

  describe("valid CUITs", () => {
    it("accepts a standard CUIT format XX-XXXXXXXX-X", () => {
      const rows = [{ CUIT: "20-12345678-9", "Nombre completo": "Juan Pérez" }]
      const result = filterValidCuits(rows, SOURCE)
      expect(result).toHaveLength(1)
    })

    it("strips dashes from the taxId in the output", () => {
      const rows = [{ CUIT: "20-12345678-9", "Nombre completo": "Juan Pérez" }]
      const result = filterValidCuits(rows, SOURCE)
      expect(result[0]!.taxId).toBe("20123456789")
    })

    it("trims whitespace from CUIT before validating", () => {
      const rows = [{ CUIT: " 20-12345678-9 ", "Nombre completo": "Juan" }]
      const result = filterValidCuits(rows, SOURCE)
      expect(result).toHaveLength(1)
    })

    it("includes the businessName from the row", () => {
      const rows = [{ CUIT: "20-12345678-9", "Nombre completo": "  Juan Pérez  " }]
      const result = filterValidCuits(rows, SOURCE)
      expect(result[0]!.businessName).toBe("Juan Pérez")
    })

    it("tags each record with the provided source name", () => {
      const rows = [{ CUIT: "20-12345678-9", "Nombre completo": "Test" }]
      const result = filterValidCuits(rows, "my-source")
      expect(result[0]!.source).toBe("my-source")
    })

    it("processes multiple valid rows", () => {
      const rows = [
        { CUIT: "20-12345678-9", "Nombre completo": "User A" },
        { CUIT: "27-87654321-3", "Nombre completo": "User B" },
        { CUIT: "30-11111111-1", "Nombre completo": "User C" },
      ]
      const result = filterValidCuits(rows, SOURCE)
      expect(result).toHaveLength(3)
    })

    it("returns an empty array when given no rows", () => {
      expect(filterValidCuits([], SOURCE)).toEqual([])
    })
  })

  // ── Invalid formats ─────────────────────────────────────────────────────────

  describe("invalid CUITs", () => {
    const invalidCases = [
      ["missing dashes", "20123456789"],
      ["too short", "20-1234567-9"],
      ["too long check digit", "20-12345678-99"],
      ["letters in body", "20-1234567A-9"],
      ["empty string", ""],
      ["only spaces", "   "],
      ["wrong separator", "20/12345678/9"],
      ["partial format", "20-12345678"],
    ]

    it.each(invalidCases)("rejects CUIT with %s: '%s'", (_label, cuit) => {
      const rows = [{ CUIT: cuit, "Nombre completo": "Test" }]
      expect(filterValidCuits(rows, SOURCE)).toHaveLength(0)
    })
  })

  // ── Mixed input ─────────────────────────────────────────────────────────────

  describe("mixed valid and invalid rows", () => {
    it("only returns valid CUITs from a mixed list", () => {
      const rows = [
        { CUIT: "20-12345678-9", "Nombre completo": "Valid" },
        { CUIT: "INVALID", "Nombre completo": "Bad" },
        { CUIT: "27-87654321-3", "Nombre completo": "Also Valid" },
        { CUIT: "", "Nombre completo": "Empty" },
      ]
      const result = filterValidCuits(rows, SOURCE)
      expect(result).toHaveLength(2)
      expect(result.map((r) => r.businessName)).toEqual(["Valid", "Also Valid"])
    })

    it("preserves order of valid rows", () => {
      const rows = [
        { CUIT: "30-11111111-1", "Nombre completo": "C" },
        { CUIT: "INVALID", "Nombre completo": "skip" },
        { CUIT: "20-12345678-9", "Nombre completo": "A" },
        { CUIT: "27-87654321-3", "Nombre completo": "B" },
      ]
      const result = filterValidCuits(rows, SOURCE)
      expect(result.map((r) => r.businessName)).toEqual(["C", "A", "B"])
    })
  })

  // ── Missing columns ─────────────────────────────────────────────────────────

  describe("missing columns", () => {
    it("uses empty string for businessName when column is missing", () => {
      const rows = [{ CUIT: "20-12345678-9" }] as Record<string, string>[]
      const result = filterValidCuits(rows, SOURCE)
      expect(result[0]!.businessName).toBe("")
    })

    it("skips rows where CUIT column is missing", () => {
      const rows = [{ "Nombre completo": "No CUIT" }] as Record<string, string>[]
      expect(filterValidCuits(rows, SOURCE)).toHaveLength(0)
    })
  })
})

// ─── loadCuitsIntoNeo4j ───────────────────────────────────────────────────────

describe("loadCuitsIntoNeo4j", () => {
  let mockRun: ReturnType<typeof vi.fn>
  let mockSession: Session

  beforeEach(() => {
    mockRun = vi.fn().mockResolvedValue({ records: [] })
    mockSession = { run: mockRun } as unknown as Session
  })

  it("calls session.run once per record", async () => {
    const records: CuitRecord[] = [
      { taxId: "20123456789", businessName: "User A", source: "csv" },
      { taxId: "27876543213", businessName: "User B", source: "csv" },
    ]
    await loadCuitsIntoNeo4j(records, mockSession)
    expect(mockRun).toHaveBeenCalledTimes(2)
  })

  it("passes the correct taxId to each query", async () => {
    const records: CuitRecord[] = [
      { taxId: "20123456789", businessName: "User A", source: "csv" },
    ]
    await loadCuitsIntoNeo4j(records, mockSession)
    const params = mockRun.mock.calls[0]![1] as Record<string, unknown>
    expect(params["id"]).toBe("20123456789")
  })

  it("passes the correct businessName to each query", async () => {
    const records: CuitRecord[] = [
      { taxId: "20123456789", businessName: "Empresa SA", source: "csv" },
    ]
    await loadCuitsIntoNeo4j(records, mockSession)
    const params = mockRun.mock.calls[0]![1] as Record<string, unknown>
    expect(params["name"]).toBe("Empresa SA")
  })

  it("passes the correct source to each query", async () => {
    const records: CuitRecord[] = [
      { taxId: "20123456789", businessName: "Test", source: "csv-poseidon" },
    ]
    await loadCuitsIntoNeo4j(records, mockSession)
    const params = mockRun.mock.calls[0]![1] as Record<string, unknown>
    expect(params["source"]).toBe("csv-poseidon")
  })

  it("does not call session.run when records list is empty", async () => {
    await loadCuitsIntoNeo4j([], mockSession)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it("processes all records even when list is large", async () => {
    const records: CuitRecord[] = Array.from({ length: 100 }, (_, i) => ({
      taxId: `2012345678${i % 10}`,
      businessName: `User ${i}`,
      source: "csv",
    }))
    await loadCuitsIntoNeo4j(records, mockSession)
    expect(mockRun).toHaveBeenCalledTimes(100)
  })

  it("throws if session.run rejects", async () => {
    mockRun.mockRejectedValueOnce(new Error("DB error"))
    const records: CuitRecord[] = [
      { taxId: "20123456789", businessName: "Test", source: "csv" },
    ]
    await expect(loadCuitsIntoNeo4j(records, mockSession)).rejects.toThrow("DB error")
  })

  it("uses a Cypher MERGE statement (idempotent)", async () => {
    const records: CuitRecord[] = [
      { taxId: "20123456789", businessName: "Test", source: "csv" },
    ]
    await loadCuitsIntoNeo4j(records, mockSession)
    const query = mockRun.mock.calls[0]![0] as string
    expect(query.toUpperCase()).toContain("MERGE")
  })
})