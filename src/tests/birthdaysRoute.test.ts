import { describe, it, expect, beforeEach, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { schemas } from "@schemas.js"

const findBirthdaysBetween = vi.fn()

vi.mock("@infrastructure/neo4j/Neo4jSource.js", () => ({
  Neo4jSource: class {
    findBirthdaysBetween = findBirthdaysBetween
  },
}))

vi.mock("@auth/activityLogger.js", () => ({
  logCuitSearch: vi.fn(),
  logPathSearch: vi.fn(),
  logRelationshipAdded: vi.fn(),
  logRelationshipDeleted: vi.fn(),
  logNodeUpdated: vi.fn(),
  logNodeViewed: vi.fn(),
  logNodeRelationshipsViewed: vi.fn(),
  logMyBaseViewed: vi.fn(),
  logCompaniesViewed: vi.fn(),
  logBirthdaysViewed: vi.fn(),
  logToKnowViewed: vi.fn(),
  logAllMyNodesViewed: vi.fn(),
  logCrossingViewed: vi.fn(),
  logNameSearch: vi.fn(),
}))

const { default: graphRoutes } = await import("@routes/graph")

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  for (const schema of Object.values(schemas)) {
    app.addSchema(schema)
  }
  await app.register(graphRoutes)
  await app.ready()
  return app
}

function get(app: FastifyInstance, from: string, to: string) {
  return app.inject({
    method: "GET",
    url: `/graph/birthdays?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  })
}

describe("GET /graph/birthdays", () => {
  let app: FastifyInstance

  beforeEach(async () => {
    findBirthdaysBetween.mockReset()
    findBirthdaysBetween.mockResolvedValue([])
    app = await buildApp()
  })

  describe("inverted ranges", () => {
    it("answers 400 when the end date is before the start date", async () => {
      const res = await get(app, "20/12/2026", "05/01/2026")
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toContain("end date cannot be earlier")
    })

    it("does not reach the database when the range is inverted", async () => {
      await get(app, "20/12/2026", "05/01/2026")
      expect(findBirthdaysBetween).not.toHaveBeenCalled()
    })
  })

  describe("ranges that wrap the year", () => {
    it("accepts 20/12/2026 to 05/01/2027", async () => {
      const res = await get(app, "20/12/2026", "05/01/2027")
      expect(res.statusCode).toBe(200)
    })

    it("passes month and day through, ignoring the year", async () => {
      await get(app, "20/12/2026", "05/01/2027")
      expect(findBirthdaysBetween).toHaveBeenCalledWith(12, 20, 1, 5)
    })

    it("accepts a wrapping range when neither endpoint carries a year", async () => {
      const res = await get(app, "20/12", "05/01")
      expect(res.statusCode).toBe(200)
    })
  })

  describe("ordinary ranges", () => {
    it("accepts a plain forward range", async () => {
      const res = await get(app, "01/03/2026", "31/03/2026")
      expect(res.statusCode).toBe(200)
    })

    it("accepts the same day on both ends", async () => {
      const res = await get(app, "17/09/2026", "17/09/2026")
      expect(res.statusCode).toBe(200)
    })

    it("answers the rows the repository returns", async () => {
      findBirthdaysBetween.mockResolvedValue([
        { taxId: "20461235787", businessName: "Alguien", birthday: "30/07/2004", sources: [], relationshipCount: 0, levelOfTrust: 0 },
      ])
      const res = await get(app, "01/07/2026", "31/07/2026")
      expect(res.json().count).toBe(1)
    })
  })

  describe("invalid input", () => {
    it("answers 400 for an unparseable date", async () => {
      const res = await get(app, "hola", "chau")
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toContain("Invalid date format")
    })

    it("answers 400 for a month out of range", async () => {
      const res = await get(app, "01/13/2026", "31/12/2026")
      expect(res.statusCode).toBe(400)
    })
  })
})
