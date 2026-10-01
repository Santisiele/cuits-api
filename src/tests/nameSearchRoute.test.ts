import { describe, it, expect, vi } from "vitest"
import Fastify from "fastify"
import { schemas } from "@schemas.js"

const searchNodesByName = vi.fn()

vi.mock("@infrastructure/neo4j/Neo4jSource.js", () => ({
  Neo4jSource: class {
    searchNodesByName = searchNodesByName
  },
}))

vi.mock("@auth/activityLogger.js", () => ({
  logNameSearch: vi.fn(),
}))

const { default: graphRoutes } = await import("@routes/graph")

describe("GET /graph/search-by-name", () => {
  it("sends how many of the relationships are with the base", async () => {
    searchNodesByName.mockResolvedValue([
      {
        taxId: "20283668364",
        businessName: "COSARINSKY FERNANDO JOSE",
        sources: [],
        inMyBase: false,
        levelOfTrust: 0,
        relationshipCount: 10,
        baseRelationshipCount: 1,
      },
    ])
    const app = Fastify()
    for (const schema of Object.values(schemas)) app.addSchema(schema)
    await app.register(graphRoutes)

    const response = await app.inject({ method: "GET", url: "/graph/search-by-name?q=cosarinsky" })

    expect(response.statusCode).toBe(200)
    expect(response.json().results[0]).toMatchObject({ relationshipCount: 10, baseRelationshipCount: 1 })
  })
})
