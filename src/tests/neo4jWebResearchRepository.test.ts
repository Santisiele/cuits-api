import { describe, it, expect, vi, beforeEach } from "vitest"
import neo4j from "neo4j-driver"

const state = {
  rows: [] as Record<string, unknown>[],
  calls: [] as { query: string; params: Record<string, unknown> }[],
}

vi.mock("@infrastructure/neo4j/Neo4jDriver.js", () => ({
  Neo4jDriver: {
    instance: {
      session: () => ({
        run: async (query: string, params: Record<string, unknown> = {}) => {
          state.calls.push({ query, params })
          return { records: state.rows.map((row) => ({ get: (key: string) => row[key] })) }
        },
        close: async () => {},
      }),
    },
  },
}))

const { Neo4jWebResearchRepository } = await import("@infrastructure/neo4j/Neo4jWebResearchRepository")
const { Queries } = await import("@infrastructure/neo4j/queries")

const repository = new Neo4jWebResearchRepository()

describe("Neo4jWebResearchRepository", () => {
  beforeEach(() => {
    state.rows = []
    state.calls = []
  })

  it("reads a research back with sources parsed and integers converted", async () => {
    state.rows = [
      {
        taxId: "30712345678",
        businessName: "ACME SA",
        r: {
          properties: {
            id: "r1",
            requestedAt: "2026-10-13T15:00:00.000Z",
            requestedBy: "santi",
            status: "done",
            summary: "Resumen",
            sources: JSON.stringify([{ url: "https://a.com", title: "A" }]),
            model: "claude-opus-5-5",
            inputTokens: neo4j.int(10),
            outputTokens: 20,
            cacheReadTokens: null,
            webSearches: neo4j.int(2),
            costUsd: 0.5,
          },
        },
      },
    ]

    expect(await repository.listRecent(50)).toEqual([
      {
        id: "r1",
        taxId: "30712345678",
        businessName: "ACME SA",
        requestedAt: "2026-10-13T15:00:00.000Z",
        requestedBy: "santi",
        status: "done",
        summary: "Resumen",
        sources: [{ url: "https://a.com", title: "A" }],
        model: "claude-opus-5-5",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        webSearches: 2,
        costUsd: 0.5,
        archivedAt: null,
        archivedBy: null,
      },
    ])
    expect(neo4j.isInt(state.calls[0]?.params["limit"])).toBe(true)
  })

  it("survives missing properties and broken sources", async () => {
    state.rows = [{ taxId: "30712345678", r: { properties: { sources: "not json" } } }]
    const [research] = await repository.listForCuit("30712345678")
    expect(research).toMatchObject({ status: "failed", summary: "", sources: [], costUsd: 0, archivedAt: null, archivedBy: null })

    state.rows = [{ taxId: "30712345678", r: { properties: { sources: "{}" } } }]
    expect((await repository.listForCuit("30712345678"))[0]?.sources).toEqual([])
  })

  it("reads who archived a research and when", async () => {
    state.rows = [{ taxId: "30712345678", r: { properties: { archivedAt: "2026-10-13T15:00:00.000Z", archivedBy: "santi" } } }]
    expect((await repository.listForCuit("30712345678"))[0]).toMatchObject({
      archivedAt: "2026-10-13T15:00:00.000Z",
      archivedBy: "santi",
    })
  })

  it("stores the sources as a JSON string", async () => {
    await repository.save({
      id: "r1",
      taxId: "30712345678",
      requestedAt: "2026-10-13T15:00:00.000Z",
      requestedBy: "santi",
      status: "done",
      summary: "Resumen",
      sources: [{ url: "https://a.com", title: "A" }],
      model: "claude-opus-5-5",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      webSearches: 4,
      costUsd: 0.1,
      archivedAt: null,
      archivedBy: null,
    })
    expect(state.calls[0]?.query).toBe(Queries.CREATE_WEB_RESEARCH)
    expect(state.calls[0]?.params["sources"]).toBe('[{"url":"https://a.com","title":"A"}]')
  })

  it("finds the subject, or nothing", async () => {
    expect(await repository.findSubject("30712345678")).toBeNull()
    state.rows = [{ businessName: null, inMyBase: true }]
    expect(await repository.findSubject("30712345678")).toEqual({ businessName: "", inMyBase: true })
  })

  it("defaults the limit to 20 until one is set", async () => {
    expect(await repository.getMonthlyLimit()).toBe(20)
    state.rows = [{ monthlyLimitUsd: null }]
    expect(await repository.getMonthlyLimit()).toBe(20)
    state.rows = [{ monthlyLimitUsd: 0 }]
    expect(await repository.getMonthlyLimit()).toBe(0)
  })

  it("sets the limit and sums the spend", async () => {
    await repository.setMonthlyLimit(5, "santi", "2026-10-13T15:00:00.000Z")
    expect(state.calls[0]?.params).toEqual({ monthlyLimitUsd: 5, updatedBy: "santi", updatedAt: "2026-10-13T15:00:00.000Z" })

    state.rows = [{ totalUsd: 1.25, count: neo4j.int(3) }]
    expect(await repository.spendSince("2026-10-01T03:00:00.000Z")).toEqual({ totalUsd: 1.25, count: 3 })
  })
})
