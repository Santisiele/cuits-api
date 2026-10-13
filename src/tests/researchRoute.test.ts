import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { schemas } from "@schemas.js"
import type { Role } from "@domain/users"
import { FakeResearcher, InMemoryWebResearchRepository, storedResearch } from "./webResearchFakes"

const state = {
  repository: new InMemoryWebResearchRepository(),
  researcher: new FakeResearcher(),
  apiKey: "test-key",
}

vi.mock("@config.js", () => ({
  config: {
    anthropic: {
      get apiKey() {
        return state.apiKey
      },
    },
  },
}))

vi.mock("@infrastructure/neo4j/Neo4jWebResearchRepository.js", () => ({
  Neo4jWebResearchRepository: class {
    findSubject(taxId: string) { return state.repository.findSubject(taxId) }
    save(...args: Parameters<InMemoryWebResearchRepository["save"]>) { return state.repository.save(...args) }
    listForCuit(taxId: string) { return state.repository.listForCuit(taxId) }
    listRecent(limit: number) { return state.repository.listRecent(limit) }
    getMonthlyLimit() { return state.repository.getMonthlyLimit() }
    setMonthlyLimit(...args: Parameters<InMemoryWebResearchRepository["setMonthlyLimit"]>) { return state.repository.setMonthlyLimit(...args) }
    spendSince(since: string) { return state.repository.spendSince(since) }
  },
}))

vi.mock("@infrastructure/anthropic/ClaudeWebResearcher.js", () => ({
  ClaudeWebResearcher: {
    withApiKey: () => ({ research: (...args: Parameters<FakeResearcher["research"]>) => state.researcher.research(...args) }),
  },
}))

vi.mock("@auth/activityLogger.js", () => ({
  logForbidden: vi.fn(),
  logWebResearch: vi.fn(),
  logResearchBudgetChanged: vi.fn(),
}))

const { default: researchRoutes } = await import("@routes/research")
const { logWebResearch, logResearchBudgetChanged, logForbidden } = await import("@auth/activityLogger.js")

async function buildApp(role: Role): Promise<FastifyInstance> {
  const app = Fastify()
  for (const schema of Object.values(schemas)) app.addSchema(schema)
  await app.register(async (instance) => {
    instance.addHook("preHandler", async (request) => {
      request.username = "santi"
      request.role = role
    })
    await instance.register(researchRoutes)
  })
  await app.ready()
  return app
}

const TAX_ID = "30712345678"

const RESEARCH_FIELDS = {
  id: expect.any(String),
  taxId: TAX_ID,
  requestedAt: expect.any(String),
  requestedBy: "santi",
  status: "done",
  summary: "ACME SA es una constructora.",
  sources: [{ url: "https://boletin.gob.ar/1", title: "Boletín Oficial" }],
  model: "claude-opus-5-5",
  costUsd: 0.342,
  webSearches: 6,
}

describe("research routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.repository = new InMemoryWebResearchRepository()
    state.repository.subjects.set(TAX_ID, { businessName: "ACME SA", inMyBase: true })
    state.researcher = new FakeResearcher()
    state.apiKey = "test-key"
  })

  it("answers 403 to a member on every route without calling Claude", async () => {
    const app = await buildApp("member")
    const responses = await Promise.all([
      app.inject({ method: "POST", url: `/research/${TAX_ID}` }),
      app.inject({ method: "GET", url: `/research/${TAX_ID}` }),
      app.inject({ method: "GET", url: "/research/budget" }),
      app.inject({ method: "PATCH", url: "/research/budget", payload: { monthlyLimitUsd: 5 } }),
      app.inject({ method: "GET", url: "/research/recent" }),
    ])

    for (const response of responses) {
      expect(response.statusCode).toBe(403)
      expect(response.json().error).toBe("forbidden")
    }
    expect(state.researcher.calls).toEqual([])
    expect(state.repository.monthlyLimitUsd).toBeNull()
    expect(logForbidden).toHaveBeenCalledTimes(5)
  })

  it("lets the creator in", async () => {
    const app = await buildApp("creator")
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/research/budget" }),
      app.inject({ method: "GET", url: "/research/recent" }),
      app.inject({ method: "GET", url: `/research/${TAX_ID}` }),
    ])
    for (const response of responses) expect(response.statusCode).toBe(200)
  })

  it("POST /research/:taxId answers 201 with every field and logs it", async () => {
    const app = await buildApp("admin")
    const response = await app.inject({ method: "POST", url: `/research/${TAX_ID}` })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual(RESEARCH_FIELDS)
    expect(state.researcher.calls).toEqual([{ businessName: "ACME SA", taxId: TAX_ID }])
    expect(logWebResearch).toHaveBeenCalledWith("santi", expect.objectContaining({ status: "done" }))
  })

  it("POST answers 409 budget_exhausted without calling Claude", async () => {
    state.repository.monthlyLimitUsd = 0
    const app = await buildApp("admin")
    const response = await app.inject({ method: "POST", url: `/research/${TAX_ID}` })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: "budget_exhausted", message: expect.any(String) })
    expect(state.researcher.calls).toEqual([])
  })

  it("POST answers 400 invalid_cuit", async () => {
    const app = await buildApp("admin")
    const response = await app.inject({ method: "POST", url: "/research/30-71234567-8" })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe("invalid_cuit")
  })

  it("POST answers 404 cuit_not_found", async () => {
    const app = await buildApp("admin")
    const response = await app.inject({ method: "POST", url: "/research/20111111112" })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe("cuit_not_found")
  })

  it("POST answers 503 research_off without an API key", async () => {
    state.apiKey = ""
    const app = await buildApp("admin")
    const response = await app.inject({ method: "POST", url: `/research/${TAX_ID}` })
    expect(response.statusCode).toBe(503)
    expect(response.json().error).toBe("research_off")
  })

  it("POST answers 502 research_failed, stores and logs the failure", async () => {
    state.researcher.failure = new Error("overloaded")
    const app = await buildApp("admin")
    const response = await app.inject({ method: "POST", url: `/research/${TAX_ID}` })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: "research_failed", message: expect.any(String) })
    expect(state.repository.saved[0]?.status).toBe("failed")
    expect(logWebResearch).toHaveBeenCalledWith("santi", expect.objectContaining({ status: "failed" }), "overloaded")
  })

  it("GET /research/:taxId lists the history with every field", async () => {
    state.repository.saved.push(storedResearch({ id: "old", requestedAt: "2026-10-01T12:00:00.000Z" }), storedResearch({ id: "new" }))
    const app = await buildApp("admin")
    const response = await app.inject({ method: "GET", url: `/research/${TAX_ID}` })

    expect(response.statusCode).toBe(200)
    expect(response.json().research.map((research: { id: string }) => research.id)).toEqual(["new", "old"])
    expect(response.json().research[0]).toEqual({
      id: "new",
      taxId: TAX_ID,
      requestedAt: "2026-10-10T12:00:00.000Z",
      requestedBy: "santi",
      status: "done",
      summary: "Resumen",
      sources: [{ url: "https://a.com", title: "A" }],
      model: "claude-opus-5-5",
      costUsd: 1.5,
      webSearches: 4,
    })
  })

  it("GET /research/:taxId answers 400 invalid_cuit", async () => {
    const app = await buildApp("admin")
    const response = await app.inject({ method: "GET", url: "/research/abc" })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe("invalid_cuit")
  })

  it("GET /research/budget wins over /research/:taxId and answers every field", async () => {
    state.repository.saved.push(storedResearch({ requestedAt: new Date().toISOString(), costUsd: 1.25 }))
    const app = await buildApp("admin")
    const response = await app.inject({ method: "GET", url: "/research/budget" })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ monthlyLimitUsd: 20, spentThisMonthUsd: 1.25, researchCountThisMonth: 1 })
  })

  it("PATCH /research/budget changes the limit and logs it", async () => {
    const app = await buildApp("admin")
    const response = await app.inject({ method: "PATCH", url: "/research/budget", payload: { monthlyLimitUsd: 7.5 } })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ monthlyLimitUsd: 7.5, spentThisMonthUsd: 0, researchCountThisMonth: 0 })
    expect(logResearchBudgetChanged).toHaveBeenCalledWith("santi", 7.5)
  })

  it("PATCH /research/budget answers 400 invalid_limit for a bad value", async () => {
    const app = await buildApp("admin")
    const payloads = [{ monthlyLimitUsd: -1 }, { monthlyLimitUsd: "5" }, {}]
    for (const payload of payloads) {
      const response = await app.inject({ method: "PATCH", url: "/research/budget", payload })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: "invalid_limit", message: expect.any(String) })
    }
    const empty = await app.inject({ method: "PATCH", url: "/research/budget" })
    expect(empty.json().error).toBe("invalid_limit")
    expect(state.repository.monthlyLimitUsd).toBeNull()
  })

  it("GET /research/recent wins over /research/:taxId and answers every field with the name", async () => {
    state.repository.saved.push(storedResearch())
    const app = await buildApp("admin")
    const response = await app.inject({ method: "GET", url: "/research/recent" })

    expect(response.statusCode).toBe(200)
    expect(response.json().research).toEqual([
      {
        id: "r1",
        taxId: TAX_ID,
        businessName: "ACME SA",
        requestedAt: "2026-10-10T12:00:00.000Z",
        requestedBy: "santi",
        status: "done",
        summary: "Resumen",
        sources: [{ url: "https://a.com", title: "A" }],
        model: "claude-opus-5-5",
        costUsd: 1.5,
        webSearches: 4,
      },
    ])
  })
})
