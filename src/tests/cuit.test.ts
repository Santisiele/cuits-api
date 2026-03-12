import { describe, it, expect, beforeEach } from "vitest"
import Fastify from "fastify"
import cuitRoutes from "@routes/cuit"
import type { ISource, SearchResult } from "@sources/ISource"
import { schemas } from "@schemas"

const VALID_CUIT = "20-12345678-9"
const UNKNOWN_CUIT = "99-99999999-9"
const INVALID_CUIT = "123"

// ---- Mock sources ----

const mockSource: ISource = {
  name: "mock",
  async search(cuit: string): Promise<SearchResult[]> {
    if (cuit === VALID_CUIT) {
      return [
        { cuit, source: "mock", file: "test.csv", data: { fullName: "Test User", phone: "123", email: "test@test.com" } },
        { cuit, source: "mock", file: "test.csv", data: { fullName: "Test User Duplicate", phone: "456", email: "dup@test.com" } },
      ]
    }
    return []
  },
}

const failingSource: ISource = {
  name: "failing",
  async search(): Promise<SearchResult[]> {
    throw new Error("Connection failed")
  },
}

const secondSource: ISource = {
  name: "mock-2",
  async search(cuit: string): Promise<SearchResult[]> {
    if (cuit === VALID_CUIT) {
      return [{ cuit, source: "mock-2", file: "other.csv", data: { fullName: "Test User 2" } }]
    }
    return []
  },
}

const emptySource: ISource = {
  name: "empty",
  async search(): Promise<SearchResult[]> {
    return []
  },
}

// ---- Helper ----

async function buildApp(sources: ISource[]) {
  const app = Fastify()
  for (const schema of Object.values(schemas)) {
    app.addSchema(schema)
  }
  await app.register(cuitRoutes, { sources })
  await app.ready()
  return app
}

// ---- Tests ----

describe("GET /cuit/:cuit", () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    app = await buildApp([mockSource])
  })

  it("returns 200 and results when CUIT is found", async () => {
    const response = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.found).toBe(true)
    expect(body.cuit).toBe(VALID_CUIT)
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results[0].data.fullName).toBe("Test User")
  })

  it("returns 404 when CUIT is not found", async () => {
    const response = await app.inject({ method: "GET", url: `/cuit/${UNKNOWN_CUIT}` })

    expect(response.statusCode).toBe(404)
    const body = response.json()
    expect(body.found).toBe(false)
    expect(body.message).toBe("CUIT not found in any source")
  })

  it("returns 400 when CUIT format is invalid", async () => {
    const response = await app.inject({ method: "GET", url: `/cuit/${INVALID_CUIT}` })

    expect(response.statusCode).toBe(400)
    const body = response.json()
    expect(body.message).toBeDefined()
  })

  it("returns 200 with partial results when one source fails", async () => {
    app = await buildApp([failingSource, secondSource])
    const response = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.found).toBe(true)
    expect(body.results[0].source).toBe("mock-2")
  })

  it("returns 500 when all sources fail", async () => {
    app = await buildApp([failingSource])
    const response = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })

    expect(response.statusCode).toBe(500)
  })

  it("returns results from all sources", async () => {
    app = await buildApp([mockSource, secondSource])
    const response = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    const sourceNames = body.results.map((r: SearchResult) => r.source)
    expect(sourceNames).toContain("mock")
    expect(sourceNames).toContain("mock-2")
  })

  it("trims whitespace from CUIT before searching", async () => {
    const response = await app.inject({ method: "GET", url: `/cuit/ ${VALID_CUIT} ` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.found).toBe(true)
  })

  it("returns 404 when no sources are registered", async () => {
    app = await buildApp([emptySource])
    const response = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })

    expect(response.statusCode).toBe(404)
  })

  it("returns all results when CUIT appears multiple times in a source", async () => {
    const response = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.results.length).toBeGreaterThanOrEqual(2)
  })

  it("returns only results from sources that found the CUIT", async () => {
    app = await buildApp([mockSource, emptySource])
    const response = await app.inject({ method: "GET", url: `/cuit/${VALID_CUIT}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.results.every((r: SearchResult) => r.source === "mock")).toBe(true)
  })
})