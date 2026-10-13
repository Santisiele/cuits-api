import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import type { Role } from "@domain/users"

vi.mock("@auth/activityLogger.js", () => ({
  logForbidden: vi.fn(),
}))

const { requireCreator } = await import("@middleware/requireCreator")
const { logForbidden } = await import("@auth/activityLogger.js")

async function buildApp(role: Role): Promise<FastifyInstance> {
  const app = Fastify()
  app.addHook("preHandler", async (request) => {
    request.username = "someone"
    request.role = role
  })
  app.get("/secret", { preHandler: requireCreator }, async () => ({ ok: true }))
  await app.ready()
  return app
}

describe("requireCreator", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("lets the creator through", async () => {
    const app = await buildApp("creator")
    const response = await app.inject({ method: "GET", url: "/secret" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
    expect(logForbidden).not.toHaveBeenCalled()
  })

  it.each(["admin", "member"] as const)("answers 403 to an %s", async (role) => {
    const app = await buildApp(role)
    const response = await app.inject({ method: "GET", url: "/secret" })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: "forbidden", message: "Only the creator can do this" })
  })

  it("logs who was turned away", async () => {
    const app = await buildApp("admin")
    await app.inject({ method: "GET", url: "/secret" })
    expect(logForbidden).toHaveBeenCalledWith("someone", "127.0.0.1", "/secret")
  })
})
