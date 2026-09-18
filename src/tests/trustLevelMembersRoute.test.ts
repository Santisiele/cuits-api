import { describe, it, expect, beforeEach, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { schemas } from "@schemas.js"
import type { TrustLevelInfo, TrustLevelMember } from "@domain/entities"

const repo = {
  findTrustLevel: vi.fn(),
  findTrustLevelMembers: vi.fn(),
}

vi.mock("@infrastructure/neo4j/Neo4jSource.js", () => ({
  Neo4jSource: class {
    getRepository() {
      return repo
    }
  },
}))

vi.mock("@auth/passwordVerifier.js", () => ({
  verifyUserPassword: vi.fn(),
  PasswordVerificationError: class extends Error {},
}))

vi.mock("@auth/activityLogger.js", () => ({
  logTrustLevelsViewed: vi.fn(),
  logTrustLevelMembersViewed: vi.fn(),
  logTrustLevelOperation: vi.fn(),
}))

const { default: trustLevelRoutes } = await import("@routes/trustLevels")
const { logTrustLevelMembersViewed } = await import("@auth/activityLogger.js")

const LEVEL: TrustLevelInfo = { value: 4, label: "Interesante", color: "green", nodeCount: 0, description: "" }

const MEMBER: TrustLevelMember = {
  taxId: "30500904557",
  businessName: "CHAMMAS SOC RESP LTDA",
  sources: ["Bolsa", "Deudores por financiera"],
  relationshipCount: 3,
  isKnown: false,
  isToKnow: true,
  trustReason: "de cordoba, cheques de primera",
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  for (const schema of Object.values(schemas)) {
    app.addSchema(schema)
  }
  await app.register(trustLevelRoutes)
  await app.ready()
  return app
}

function get(app: FastifyInstance, query: string) {
  return app.inject({ method: "GET", url: `/trust-levels/nodes${query}` })
}

describe("GET /trust-levels/nodes", () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    repo.findTrustLevel.mockResolvedValue(LEVEL)
    repo.findTrustLevelMembers.mockResolvedValue([MEMBER])
    app = await buildApp()
  })

  describe("a level that exists", () => {
    it("answers 200", async () => {
      const res = await get(app, "?level=4")
      expect(res.statusCode).toBe(200)
    })

    it("returns the level so the list can be titled", async () => {
      const res = await get(app, "?level=4")
      expect(res.json().level).toMatchObject({ value: 4, label: "Interesante", color: "green", nodeCount: 1 })
    })

    it("returns every field of each CUIT, the reason included", async () => {
      const res = await get(app, "?level=4")
      expect(res.json().members).toEqual([MEMBER])
    })

    it("filters on the level asked for", async () => {
      await get(app, "?level=4")
      expect(repo.findTrustLevelMembers).toHaveBeenCalledWith(4)
    })

    it("records who looked at the list", async () => {
      await get(app, "?level=4")
      expect(logTrustLevelMembersViewed).toHaveBeenCalledWith(undefined, 4, 1)
    })
  })

  describe("a bad level", () => {
    it("answers 400 when the level is missing", async () => {
      const res = await get(app, "")
      expect(res.statusCode).toBe(400)
    })

    it("answers 400 for text", async () => {
      const res = await get(app, "?level=alto")
      expect(res.statusCode).toBe(400)
      expect(res.json().message).toBe("The level must be a whole number")
    })

    it("answers 400 for a decimal", async () => {
      expect((await get(app, "?level=2.5")).statusCode).toBe(400)
    })

    it("answers 400 for a negative number", async () => {
      expect((await get(app, "?level=-1")).statusCode).toBe(400)
    })

    it("answers 400 for level 0 and says why", async () => {
      const res = await get(app, "?level=0")
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: "reserved_level" })
      expect(res.json().message).toContain("no list for level 0")
    })

    it("answers 404 for a level that does not exist", async () => {
      repo.findTrustLevel.mockResolvedValue(null)
      const res = await get(app, "?level=99")
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ error: "level_not_found" })
    })

    it("never reaches the graph for a malformed level", async () => {
      await get(app, "?level=alto")
      expect(repo.findTrustLevel).not.toHaveBeenCalled()
      expect(repo.findTrustLevelMembers).not.toHaveBeenCalled()
    })
  })

  describe("when the graph fails", () => {
    it("answers 500 without leaking the error", async () => {
      repo.findTrustLevelMembers.mockRejectedValue(new Error("Aura down"))
      const res = await get(app, "?level=4")
      expect(res.statusCode).toBe(500)
      expect(res.json().message).toBe("Graph database unavailable")
    })
  })
})
