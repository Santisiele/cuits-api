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
    findById(id: string) { return state.repository.findById(id) }
    archive(...args: Parameters<InMemoryWebResearchRepository["archive"]>) { return state.repository.archive(...args) }
    restore(id: string) { return state.repository.restore(id) }
    listArchived(limit: number) { return state.repository.listArchived(limit) }
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
  logResearchArchived: vi.fn(),
  logResearchRestored: vi.fn(),
}))

const { default: researchRoutes } = await import("@routes/research")
const { logWebResearch, logResearchBudgetChanged, logResearchArchived, logResearchRestored, logForbidden } = await import(
  "@auth/activityLogger.js"
)

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
const ID = "3f2b8c1e-9a4d-4c7b-8e1f-0a2b3c4d5e6f"

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
  archivedAt: null,
  archivedBy: null,
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
      app.inject({ method: "GET", url: "/research/archived" }),
      app.inject({ method: "POST", url: `/research/${ID}/archive` }),
      app.inject({ method: "POST", url: `/research/${ID}/restore` }),
    ])

    for (const response of responses) {
      expect(response.statusCode).toBe(403)
      expect(response.json().error).toBe("forbidden")
    }
    expect(state.researcher.calls).toEqual([])
    expect(state.repository.monthlyLimitUsd).toBeNull()
    expect(logForbidden).toHaveBeenCalledTimes(8)
  })

  it("answers 403 to an admin on the archived list, on restore and on changing the limit", async () => {
    state.repository.saved.push(storedResearch({ id: ID, archivedAt: "2026-10-12T12:00:00.000Z", archivedBy: "santi" }))
    const app = await buildApp("admin")
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/research/archived" }),
      app.inject({ method: "POST", url: `/research/${ID}/restore` }),
      app.inject({ method: "PATCH", url: "/research/budget", payload: { monthlyLimitUsd: 5 } }),
    ])

    for (const response of responses) {
      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ error: "forbidden", message: "Only the creator can do this" })
    }
    expect(state.repository.saved[0]?.archivedAt).toBe("2026-10-12T12:00:00.000Z")
    expect(state.repository.monthlyLimitUsd).toBeNull()
    expect(logResearchRestored).not.toHaveBeenCalled()
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
      archivedAt: null,
      archivedBy: null,
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
    const app = await buildApp("creator")
    const response = await app.inject({ method: "PATCH", url: "/research/budget", payload: { monthlyLimitUsd: 7.5 } })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ monthlyLimitUsd: 7.5, spentThisMonthUsd: 0, researchCountThisMonth: 0 })
    expect(logResearchBudgetChanged).toHaveBeenCalledWith("santi", 7.5)
  })

  it("PATCH /research/budget answers 400 invalid_limit for a bad value", async () => {
    const app = await buildApp("creator")
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
        archivedAt: null,
        archivedBy: null,
      },
    ])
  })

  it("POST /research/:id/archive archives for an admin, answers every field and logs it", async () => {
    state.repository.saved.push(storedResearch({ id: ID }))
    const app = await buildApp("admin")
    const response = await app.inject({ method: "POST", url: `/research/${ID}/archive` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      id: ID,
      taxId: TAX_ID,
      requestedAt: "2026-10-10T12:00:00.000Z",
      requestedBy: "santi",
      status: "done",
      summary: "Resumen",
      sources: [{ url: "https://a.com", title: "A" }],
      model: "claude-opus-5-5",
      costUsd: 1.5,
      webSearches: 4,
      archivedAt: expect.any(String),
      archivedBy: "santi",
    })
    expect(state.repository.saved[0]?.archivedAt).toBe(response.json().archivedAt)
    expect(logResearchArchived).toHaveBeenCalledWith("santi", expect.objectContaining({ id: ID, taxId: TAX_ID }))

    const history = await app.inject({ method: "GET", url: `/research/${TAX_ID}` })
    expect(history.json().research).toEqual([])
    const recent = await app.inject({ method: "GET", url: "/research/recent" })
    expect(recent.json().research).toEqual([])
  })

  it("POST /research/:id/archive answers 409 already_archived", async () => {
    state.repository.saved.push(storedResearch({ id: ID, archivedAt: "2026-10-12T12:00:00.000Z", archivedBy: "ana" }))
    const app = await buildApp("admin")
    const response = await app.inject({ method: "POST", url: `/research/${ID}/archive` })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: "already_archived", message: expect.any(String) })
    expect(logResearchArchived).not.toHaveBeenCalled()
  })

  it("archive and restore answer 404 research_not_found for an unknown or malformed id", async () => {
    const app = await buildApp("creator")
    const responses = await Promise.all([
      app.inject({ method: "POST", url: `/research/${ID}/archive` }),
      app.inject({ method: "POST", url: "/research/not-a-uuid/archive" }),
      app.inject({ method: "POST", url: `/research/${ID}/restore` }),
      app.inject({ method: "POST", url: "/research/%27%3B%20DROP/restore" }),
    ])

    for (const response of responses) {
      expect(response.statusCode).toBe(404)
      expect(response.json()).toEqual({ error: "research_not_found", message: expect.any(String) })
    }
  })

  it("POST /research/:id/restore restores for the creator, answers every field and logs it", async () => {
    state.repository.saved.push(storedResearch({ id: ID, archivedAt: "2026-10-12T12:00:00.000Z", archivedBy: "ana" }))
    const app = await buildApp("creator")
    const response = await app.inject({ method: "POST", url: `/research/${ID}/restore` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      id: ID,
      taxId: TAX_ID,
      requestedAt: "2026-10-10T12:00:00.000Z",
      requestedBy: "santi",
      status: "done",
      summary: "Resumen",
      sources: [{ url: "https://a.com", title: "A" }],
      model: "claude-opus-5-5",
      costUsd: 1.5,
      webSearches: 4,
      archivedAt: null,
      archivedBy: null,
    })
    expect(state.repository.saved[0]?.archivedAt).toBeNull()
    expect(logResearchRestored).toHaveBeenCalledWith("santi", expect.objectContaining({ id: ID, taxId: TAX_ID }))
  })

  it("POST /research/:id/restore answers 409 not_archived", async () => {
    state.repository.saved.push(storedResearch({ id: ID }))
    const app = await buildApp("creator")
    const response = await app.inject({ method: "POST", url: `/research/${ID}/restore` })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: "not_archived", message: expect.any(String) })
  })

  it("GET /research/archived wins over /research/:taxId and answers every field with the name", async () => {
    state.repository.saved.push(
      storedResearch({ id: "live" }),
      storedResearch({ id: ID, archivedAt: "2026-10-12T12:00:00.000Z", archivedBy: "ana" })
    )
    const app = await buildApp("creator")
    const response = await app.inject({ method: "GET", url: "/research/archived" })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      research: [
        {
          id: ID,
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
          archivedAt: "2026-10-12T12:00:00.000Z",
          archivedBy: "ana",
        },
      ],
    })
  })

  it("keeps counting archived research in the budget", async () => {
    const now = new Date().toISOString()
    state.repository.saved.push(storedResearch({ id: ID, requestedAt: now, costUsd: 1.25, archivedAt: now, archivedBy: "ana" }))
    const app = await buildApp("admin")
    const response = await app.inject({ method: "GET", url: "/research/budget" })

    expect(response.json()).toEqual({ monthlyLimitUsd: 20, spentThisMonthUsd: 1.25, researchCountThisMonth: 1 })
  })
})
