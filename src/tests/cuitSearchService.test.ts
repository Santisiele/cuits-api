import { describe, it, expect, vi } from "vitest"
import { CuitSearchService, SourceRegistry, isValidCuit } from "@application/CuitSearchService"
import type { ISource } from "@ports/interfaces"
import type { SearchResult } from "@domain/entities"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSource(name: string, results: SearchResult[] = []): ISource {
  return { name, search: vi.fn(async () => results) }
}

function makeFailingSource(name = "failing"): ISource {
  return { name, search: vi.fn(async () => { throw new Error("fail") }) }
}

function makeResult(cuit: string, source: string): SearchResult {
  return { cuit, source, file: "test.csv", data: { fullName: "Test" } }
}

// ─── isValidCuit ──────────────────────────────────────────────────────────────

describe("isValidCuit", () => {
  const valid = ["20-12345678-9", "27-87654321-3", "30-11111111-1"]
  const invalid = ["", "123", "20-1234567-9", "20-12345678-99", "20_12345678_9", "AB-12345678-9"]

  it.each(valid)("returns true for valid CUIT: %s", (cuit) => {
    expect(isValidCuit(cuit)).toBe(true)
  })

  it.each(invalid)("returns false for invalid CUIT: %s", (cuit) => {
    expect(isValidCuit(cuit)).toBe(false)
  })
})

// ─── SourceRegistry ───────────────────────────────────────────────────────────

describe("SourceRegistry", () => {
  it("returns all registered sources", () => {
    const a = makeSource("a")
    const b = makeSource("b")
    const registry = new SourceRegistry([a, b])
    expect(registry.all()).toEqual([a, b])
  })

  it("count returns the number of sources", () => {
    const registry = new SourceRegistry([makeSource("a"), makeSource("b"), makeSource("c")])
    expect(registry.count).toBe(3)
  })

  it("returns empty array when no sources registered", () => {
    expect(new SourceRegistry([]).all()).toEqual([])
  })

  it("count is 0 when no sources registered", () => {
    expect(new SourceRegistry([]).count).toBe(0)
  })
})

// ─── CuitSearchService ────────────────────────────────────────────────────────

describe("CuitSearchService", () => {
  const CUIT = "20-12345678-9"

  describe("searchAll", () => {
    it("returns results from all sources", async () => {
      const service = new CuitSearchService(new SourceRegistry([
        makeSource("a", [makeResult(CUIT, "a")]),
        makeSource("b", [makeResult(CUIT, "b")]),
      ]))
      const { results } = await service.searchAll(CUIT)
      expect(results.map((r) => r.source)).toContain("a")
      expect(results.map((r) => r.source)).toContain("b")
    })

    it("returns failedCount=0 when all sources succeed", async () => {
      const service = new CuitSearchService(new SourceRegistry([
        makeSource("a", [makeResult(CUIT, "a")]),
      ]))
      const { failedCount } = await service.searchAll(CUIT)
      expect(failedCount).toBe(0)
    })

    it("returns failedCount=1 when one source fails", async () => {
      const service = new CuitSearchService(new SourceRegistry([
        makeFailingSource("bad"),
        makeSource("good", [makeResult(CUIT, "good")]),
      ]))
      const { failedCount } = await service.searchAll(CUIT)
      expect(failedCount).toBe(1)
    })

    it("returns failedCount equal to total sources when all fail", async () => {
      const service = new CuitSearchService(new SourceRegistry([
        makeFailingSource("a"),
        makeFailingSource("b"),
      ]))
      const { failedCount } = await service.searchAll(CUIT)
      expect(failedCount).toBe(2)
    })

    it("returns empty results when all sources fail", async () => {
      const service = new CuitSearchService(new SourceRegistry([makeFailingSource()]))
      const { results } = await service.searchAll(CUIT)
      expect(results).toEqual([])
    })

    it("returns empty results when all sources return nothing", async () => {
      const service = new CuitSearchService(new SourceRegistry([makeSource("empty")]))
      const { results } = await service.searchAll(CUIT)
      expect(results).toEqual([])
    })

    it("passes taxId to each source", async () => {
      const source = makeSource("spy", [makeResult(CUIT, "spy")])
      const service = new CuitSearchService(new SourceRegistry([source]))
      await service.searchAll(CUIT)
      expect(source.search).toHaveBeenCalledWith(CUIT, undefined)
    })

    it("passes maxDepth to each source", async () => {
      const source = makeSource("spy", [makeResult(CUIT, "spy")])
      const service = new CuitSearchService(new SourceRegistry([source]))
      await service.searchAll(CUIT, 5)
      expect(source.search).toHaveBeenCalledWith(CUIT, 5)
    })

    it("queries all sources in parallel", async () => {
      const calls: number[] = []
      const makeTimedSource = (name: string, delayMs: number): ISource => ({
        name,
        search: vi.fn(async () => {
          calls.push(Date.now())
          await new Promise((r) => setTimeout(r, delayMs))
          return [makeResult(CUIT, name)]
        }),
      })

      const service = new CuitSearchService(new SourceRegistry([
        makeTimedSource("a", 80),
        makeTimedSource("b", 80),
      ]))

      const start = Date.now()
      await service.searchAll(CUIT)
      const elapsed = Date.now() - start

      // Both sources started nearly simultaneously
      expect(calls).toHaveLength(2)
      expect(Math.abs(calls[0]! - calls[1]!)).toBeLessThan(30)
      // Total time close to 80ms, not 160ms
      expect(elapsed).toBeLessThan(150)
    })

    it("flattens results from multiple sources into a single array", async () => {
      const service = new CuitSearchService(new SourceRegistry([
        makeSource("a", [makeResult(CUIT, "a"), makeResult(CUIT, "a")]),
        makeSource("b", [makeResult(CUIT, "b")]),
      ]))
      const { results } = await service.searchAll(CUIT)
      expect(results).toHaveLength(3)
    })

    it("handles a mix of failing and empty sources gracefully", async () => {
      const service = new CuitSearchService(new SourceRegistry([
        makeFailingSource("bad"),
        makeSource("empty"),
        makeSource("good", [makeResult(CUIT, "good")]),
      ]))
      const { results, failedCount } = await service.searchAll(CUIT)
      expect(results).toHaveLength(1)
      expect(failedCount).toBe(1)
    })
  })
})