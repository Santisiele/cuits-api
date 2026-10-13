import { describe, it, expect, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { schemas } from "@schemas.js"
import type { Role } from "@domain/users"

vi.mock("@infrastructure/neo4j/Neo4jSource.js", () => ({
  Neo4jSource: class {
    getRepository() {
      return new Proxy({}, { get: (_, key) => (key === "then" ? undefined : vi.fn().mockResolvedValue(null)) })
    }
  },
}))

vi.mock("@auth/passwordVerifier.js", () => ({
  verifyUserPassword: vi.fn(),
  PasswordVerificationError: class extends Error {},
}))

vi.mock("@auth/activityLogger.js", () => ({
  logLogin: vi.fn(),
  logLoginFailed: vi.fn(),
  logLogout: vi.fn(),
  logUnauthorized: vi.fn(),
  logForbidden: vi.fn(),
  logUserOperation: vi.fn(),
  logCuitSearch: vi.fn(),
  logNameSearch: vi.fn(),
  logPathSearch: vi.fn(),
  logRelationshipAdded: vi.fn(),
  logRelationshipDeleted: vi.fn(),
  logNodeViewed: vi.fn(),
  logNodeRelationshipsViewed: vi.fn(),
  logMyBaseViewed: vi.fn(),
  logCompaniesViewed: vi.fn(),
  logNodeUpdated: vi.fn(),
  logBirthdaysViewed: vi.fn(),
  logToKnowViewed: vi.fn(),
  logCrossingViewed: vi.fn(),
  logAllMyNodesViewed: vi.fn(),
  logSourceCreated: vi.fn(),
  logSourceOperationInitiated: vi.fn(),
  logSourceOperationCompleted: vi.fn(),
  logSourceOperationFailed: vi.fn(),
  logTrustLevelsViewed: vi.fn(),
  logTrustLevelMembersViewed: vi.fn(),
  logTrustLevelOperation: vi.fn(),
}))

const { default: sourceAdminRoutes } = await import("@routes/sources")
const { default: trustLevelRoutes } = await import("@routes/trustLevels")
const { default: graphRoutes } = await import("@routes/graph")

async function buildApp(role: Role): Promise<FastifyInstance> {
  const app = Fastify()
  for (const schema of Object.values(schemas)) app.addSchema(schema)
  await app.register(async (instance) => {
    instance.addHook("preHandler", async (request) => {
      request.username = "someone"
      request.role = role
    })
    await instance.register(sourceAdminRoutes)
    await instance.register(trustLevelRoutes)
    await instance.register(graphRoutes)
  })
  await app.ready()
  return app
}

const ADMIN_ONLY = [
  { method: "PATCH", url: "/sources/Bolsa", payload: { newName: "X", password: "p" } },
  { method: "POST", url: "/sources/merge", payload: { sourceToKeep: "A", sourceToDrop: "B", password: "p" } },
  { method: "DELETE", url: "/sources/Bolsa", payload: { password: "p" } },
  { method: "POST", url: "/nodes/30123456789/sources", payload: { sourceName: "A", mode: "add", password: "p" } },
  { method: "POST", url: "/trust-levels", payload: { label: "X", color: "green", password: "p" } },
  { method: "PATCH", url: "/trust-levels/1", payload: { label: "X", password: "p" } },
  { method: "DELETE", url: "/trust-levels/1", payload: { password: "p" } },
  { method: "POST", url: "/graph/relationship", payload: { fromTaxId: "30-12345678-9", toTaxId: "20-12345678-9", relationshipType: 1 } },
  { method: "DELETE", url: "/graph/relationship", payload: { fromTaxId: "30-12345678-9", toTaxId: "20-12345678-9", relationshipType: 1 } },
] as const

describe("admin-only routes", () => {
  it.each(ADMIN_ONLY)("$method $url answers 403 to a member", async (call) => {
    const app = await buildApp("member")
    const response = await app.inject({ method: call.method, url: call.url, payload: call.payload })
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe("forbidden")
  })

  it.each(ADMIN_ONLY)("$method $url lets an admin past the guard", async (call) => {
    const app = await buildApp("admin")
    const response = await app.inject({ method: call.method, url: call.url, payload: call.payload })
    expect(response.statusCode).not.toBe(403)
  })

  it.each(ADMIN_ONLY)("$method $url lets the creator past the guard", async (call) => {
    const app = await buildApp("creator")
    const response = await app.inject({ method: call.method, url: call.url, payload: call.payload })
    expect(response.statusCode).not.toBe(403)
  })

  it("keeps reading open to members", async () => {
    const app = await buildApp("member")
    const response = await app.inject({ method: "GET", url: "/trust-levels" })
    expect(response.statusCode).not.toBe(403)
  })
})
