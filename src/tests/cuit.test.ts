import { describe, it, expect, beforeEach, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import cuitRoutes from "@routes/cuit"
import type { ISource } from "@ports/interfaces"
import type { SearchResult } from "@domain/entities"
import { schemas } from "@schemas"

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_CUIT = "20-12345678-9"
const VALID_CUIT_2 = "27-87654321-3"
const UNKNOWN_CUIT = "99-99999999-9"
const INVALID_CUITS = ["123", "20-1234567-9", "2012345678-9", "20-12345678-99", "", "   "]

// ─── Mock factories ───────────────────────────────────────────────────────────

/**
 * Creates a mock source that returns results for specific CUITs.
 */
function makeSource(
  name: string,
  resultsByCuit: Record<string, SearchResult[]>
): ISource {
  return {
    name,
    async search(taxId: string): Promise<SearchResult[]> {
      return resultsByCuit[taxId] ?? []
    },
  }
}

/**
 * Creates a source that always throws.
 */
function makeFailingSource(name = "failing"): ISource {
  return {
    name,
    async search(): Promise<SearchResult[]> {
      throw new Error("Connection refused")
    },
  }
}

/**
 * Creates a source that always returns empty results.
 */
function makeEmptySource(name = "empty"): ISource {
  return { name, async search(): Promise<SearchResult[]> { return [] } }
}

/**
 * Creates a source with configurable delay (simulates slow I/O).
 */
function makeSlowSource(name: string, delayMs: number, results: SearchResult[]): ISource {
  return {
    name,
    async search(): Promise<SearchResult[]> {
      await new Promise((r) => setTimeout(r, delayMs))
      return results
    },
  }
}

// ─── Sample results ───────────────────────────────────────────────────────────

function makeCsvResult(cuit: string, source = "mock"): SearchResult {
  return {
    cuit,
    source,
    file: "test.csv",
    data: { fullName: "Test User", phone: "123", email: "test@test.com" },
  }
}

function makeGraphResult(cuit: string, source = "neo4j"): SearchResult {
  return {
    cuit,
    source,
    file: "neo4j",
    data: {
      businessName: "Test Corp SA",
      inMyBase: false,
      pathToBase: [
        { taxId: "20-99999999-1", businessName: "Base Node", relationshipType: "Employer", inMyBase: true },
      ],
    },
  }
}

// ─── App builder ──────────────────────────────────────────────────────────────

async function buildApp(sources: ISource[]): Promise<FastifyInstance> {
  const app = Fastify()
  for (const schema of Object.values(schemas)) {
    app.addSchema(schema)
  }
  await app.register(cuitRoutes, { sources })
  await app.ready()
  return app
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("GET /cuit/:cuit", () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildApp([
      makeSource("mock", { [VALID_CUIT]: [makeCsvResult(VALID_CUIT)] }),
    ])
  })

  // ── Happy path ─────────────────────────────────────────────────────────────

  describe("successful searches", () => {
    it("returns 200 with found=true when CUIT exists", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.found).toBe(true)
      expect(body.cuit).toBe(VALID_CUIT)
    })

    it("returns the matching results array", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      const body = res.json()
      expect(Array.isArray(body.results)).toBe(true)
      expect(body.results.length).toBeGreaterThan(0)
    })

    it("includes correct source name in results", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      const body = res.json()
      expect(body.results[0].source).toBe("mock")
    })

    it("returns all results when CUIT appears multiple times in a source", async () => {
      app = await buildApp([
        makeSource("mock", {
          [VALID_CUIT]: [
            makeCsvResult(VALID_CUIT),
            { ...makeCsvResult(VALID_CUIT), data: { fullName: "Duplicate User" } },
          ],
        }),
      ])
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      expect(res.json().results.length).toBeGreaterThanOrEqual(2)
    })

    it("aggregates results from multiple sources", async () => {
      app = await buildApp([
        makeSource("source-a", { [VALID_CUIT]: [makeCsvResult(VALID_CUIT, "source-a")] }),
        makeSource("source-b", { [VALID_CUIT]: [makeCsvResult(VALID_CUIT, "source-b")] }),
      ])
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      const sources = res.json().results.map((r: SearchResult) => r.source)
      expect(sources).toContain("source-a")
      expect(sources).toContain("source-b")
    })

    it("returns only results from sources that found the CUIT", async () => {
      app = await buildApp([
        makeSource("mock", { [VALID_CUIT]: [makeCsvResult(VALID_CUIT)] }),
        makeEmptySource("empty"),
      ])
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      const body = res.json()
      expect(body.results.every((r: SearchResult) => r.source === "mock")).toBe(true)
    })

    it("includes graph results with pathToBase", async () => {
      app = await buildApp([
        makeSource("neo4j", { [VALID_CUIT]: [makeGraphResult(VALID_CUIT)] }),
      ])
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      const body = res.json()
      expect(body.results[0].data.pathToBase).toBeDefined()
      expect(Array.isArray(body.results[0].data.pathToBase)).toBe(true)
    })

    it("handles multiple different CUITs independently", async () => {
      app = await buildApp([
        makeSource("mock", {
          [VALID_CUIT]: [makeCsvResult(VALID_CUIT)],
          [VALID_CUIT_2]: [makeCsvResult(VALID_CUIT_2)],
        }),
      ])

      const res1 = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      const res2 = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT_2}` })

      expect(res1.json().cuit).toBe(VALID_CUIT)
      expect(res2.json().cuit).toBe(VALID_CUIT_2)
    })
  })

  // ── Fault tolerance ────────────────────────────────────────────────────────

  describe("fault tolerance", () => {
    it("returns 200 with partial results when one source fails", async () => {
      app = await buildApp([
        makeFailingSource("failing"),
        makeSource("working", { [VALID_CUIT]: [makeCsvResult(VALID_CUIT, "working")] }),
      ])
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      expect(res.statusCode).toBe(200)
      expect(res.json().results[0].source).toBe("working")
    })

    it("returns 500 when all sources fail", async () => {
      app = await buildApp([makeFailingSource("a"), makeFailingSource("b")])
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      expect(res.statusCode).toBe(500)
      expect(res.json().message).toBe("All sources failed")
    })

    it("does not propagate individual source errors to the response", async () => {
      app = await buildApp([
        makeFailingSource(),
        makeSource("good", { [VALID_CUIT]: [makeCsvResult(VALID_CUIT, "good")] }),
      ])
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      expect(res.json().message).toBeUndefined()
    })

    it("sources are queried in parallel (total time close to slowest, not sum)", async () => {
      const result = makeCsvResult(VALID_CUIT, "slow")
      app = await buildApp([
        makeSlowSource("slow-a", 100, [result]),
        makeSlowSource("slow-b", 100, [result]),
      ])
      const start = Date.now()
      await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      const elapsed = Date.now() - start
      // If parallel: ~100ms. If sequential: ~200ms.
      expect(elapsed).toBeLessThan(180)
    })
  })

  // ── Not found ──────────────────────────────────────────────────────────────

  describe("not found", () => {
    it("returns 404 when CUIT is not found in any source", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${UNKNOWN_CUIT}` })
      expect(res.statusCode).toBe(404)
      const body = res.json()
      expect(body.found).toBe(false)
      expect(body.message).toBe("CUIT not found in any source")
    })

    it("returns 404 when no sources are registered", async () => {
      app = await buildApp([makeEmptySource()])
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      expect(res.statusCode).toBe(404)
    })

    it("returns cuit field in 404 body", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${UNKNOWN_CUIT}` })
      expect(res.json().cuit).toBe(UNKNOWN_CUIT)
    })
  })

  // ── Validation ─────────────────────────────────────────────────────────────

  describe("CUIT format validation", () => {
    it.each(INVALID_CUITS.filter(Boolean))(
      "returns 400 for invalid CUIT format: '%s'",
      async (invalidCuit) => {
        const res = await app.inject({ method: "GET", url: `/cuit/${invalidCuit}` })
        expect(res.statusCode).toBe(400)
        expect(res.json().message).toBeDefined()
      }
    )

    it("accepts a correctly formatted CUIT", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      expect(res.statusCode).not.toBe(400)
    })

    it("does not call sources when CUIT format is invalid", async () => {
      const searchSpy = vi.fn(async () => [])
      const spySource: ISource = { name: "spy", search: searchSpy }
      app = await buildApp([spySource])
      await app.inject({ method: "GET", url: "/cuit/INVALID" })
      expect(searchSpy).not.toHaveBeenCalled()
    })
  })

  // ── maxDepth parameter ─────────────────────────────────────────────────────

  describe("maxDepth query parameter", () => {
    it("accepts a valid maxDepth", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}?maxDepth=5` })
      expect(res.statusCode).toBe(200)
    })

    it("returns 400 for maxDepth = 0", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}?maxDepth=0` })
      expect(res.statusCode).toBe(400)
    })

    it("returns 400 for maxDepth > 10", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}?maxDepth=11` })
      expect(res.statusCode).toBe(400)
    })

    it("returns 400 for non-numeric maxDepth", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}?maxDepth=abc` })
      expect(res.statusCode).toBe(400)
    })

    it("passes maxDepth to sources", async () => {
      let receivedDepth: number | undefined
      const depthCapture: ISource = {
        name: "depth-capture",
        async search(_taxId, maxDepth): Promise<SearchResult[]> {
          receivedDepth = maxDepth
          return [makeCsvResult(VALID_CUIT, "depth-capture")]
        },
      }
      app = await buildApp([depthCapture])
      await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}?maxDepth=7` })
      expect(receivedDepth).toBe(7)
    })

    it("uses default maxDepth of 3 when not specified", async () => {
      let receivedDepth: number | undefined
      const depthCapture: ISource = {
        name: "depth-capture",
        async search(_taxId, maxDepth): Promise<SearchResult[]> {
          receivedDepth = maxDepth
          return [makeCsvResult(VALID_CUIT, "depth-capture")]
        },
      }
      app = await buildApp([depthCapture])
      await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      expect(receivedDepth).toBe(3)
    })
  })

  // ── Response shape ─────────────────────────────────────────────────────────

  describe("response shape", () => {
    it("200 body has cuit, found, results fields", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      const body = res.json()
      expect(body).toHaveProperty("cuit")
      expect(body).toHaveProperty("found")
      expect(body).toHaveProperty("results")
    })

    it("each result has cuit, source, file, data fields", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      const result = res.json().results[0]
      expect(result).toHaveProperty("cuit")
      expect(result).toHaveProperty("source")
      expect(result).toHaveProperty("file")
      expect(result).toHaveProperty("data")
    })

    it("404 body has found=false and message", async () => {
      const res = await app.inject({ method: "GET", url: `/cuit/${UNKNOWN_CUIT}` })
      const body = res.json()
      expect(body.found).toBe(false)
      expect(body.message).toBeTruthy()
    })

    it("400 body has a message field", async () => {
      const res = await app.inject({ method: "GET", url: "/cuit/INVALID" })
      expect(res.json().message).toBeTruthy()
    })

    it("500 body has a message field", async () => {
      app = await buildApp([makeFailingSource()])
      const res = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })
      expect(res.json().message).toBeTruthy()
    })
  })
})