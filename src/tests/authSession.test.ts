import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import jwt from "jsonwebtoken"
import { config } from "@config.js"
import { InMemoryUserRepository, plainHasher, storedUser } from "./userFakes"

vi.mock("@auth/activityLogger.js", () => ({
  logUnauthorized: vi.fn(),
  logForbidden: vi.fn(),
}))

const { AuthService } = await import("@auth/AuthService")
const { createAuthMiddleware } = await import("@middleware/authMiddleware")
const { requireAdmin } = await import("@middleware/requireAdmin")
const { logUnauthorized, logForbidden } = await import("@auth/activityLogger.js")

function tokenFor(username: string, secret = config.auth.jwtSecret): string {
  return jwt.sign({ username, role: "admin" }, secret, { expiresIn: "1h" })
}

describe("AuthService.login", () => {
  it("signs a token carrying the username and role", async () => {
    const auth = new AuthService(new InMemoryUserRepository([storedUser({ role: "member" })]), plainHasher)
    const result = await auth.login("SANTI", "secret123")

    expect(result).toMatchObject({ success: true, username: "santi", role: "member" })
    if (!result.success) throw new Error("login failed")
    expect(auth.verify(result.token)).toMatchObject({ username: "santi", role: "member" })
  })

  it("rejects an unknown user, a wrong password and a disabled user", async () => {
    const auth = new AuthService(
      new InMemoryUserRepository([storedUser(), storedUser({ username: "luchi", disabledAt: "2026-09-01T00:00:00.000Z" })]),
      plainHasher
    )
    expect(await auth.login("nadie", "secret123")).toEqual({ success: false, reason: "user_not_found" })
    expect(await auth.login("santi", "wrong")).toEqual({ success: false, reason: "invalid_credentials" })
    expect(await auth.login("luchi", "secret123")).toEqual({ success: false, reason: "user_disabled" })
  })
})

describe("AuthService.resolveSession", () => {
  const repository = new InMemoryUserRepository([
    storedUser({ role: "member" }),
    storedUser({ username: "luchi", disabledAt: "2026-09-01T00:00:00.000Z" }),
  ])
  const auth = new AuthService(repository, plainHasher)

  it("takes the role from the graph, not from the token", async () => {
    expect(await auth.resolveSession(tokenFor("santi"))).toEqual({ valid: true, username: "santi", role: "member" })
  })

  it("rejects a bad token, a deleted user and a disabled user", async () => {
    expect(await auth.resolveSession(tokenFor("santi", "other-secret"))).toEqual({ valid: false, reason: "invalid_token" })
    expect(await auth.resolveSession(tokenFor("nadie"))).toEqual({ valid: false, reason: "user_not_found" })
    expect(await auth.resolveSession(tokenFor("luchi"))).toEqual({ valid: false, reason: "user_disabled" })
  })
})

describe("auth middleware and requireAdmin", () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    const repository = new InMemoryUserRepository([
      storedUser(),
      storedUser({ username: "luchi", role: "member" }),
      storedUser({ username: "flavia", role: "member", disabledAt: "2026-09-01T00:00:00.000Z" }),
    ])
    app = Fastify()
    app.addHook("preHandler", createAuthMiddleware(new AuthService(repository, plainHasher)))
    app.get("/open", async (request) => ({ username: request.username, role: request.role }))
    app.get("/admin", { preHandler: requireAdmin }, async () => ({ ok: true }))
    await app.ready()
  })

  function get(url: string, token?: string) {
    return app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} })
  }

  it("answers 401 without a token", async () => {
    const response = await get("/open")
    expect(response.statusCode).toBe(401)
    expect(logUnauthorized).toHaveBeenCalledWith(expect.any(String), "/open", "missing_token")
  })

  it("answers 401 for a disabled user even with a valid token", async () => {
    const response = await get("/open", tokenFor("flavia"))
    expect(response.statusCode).toBe(401)
    expect(logUnauthorized).toHaveBeenCalledWith(expect.any(String), "/open", "user_disabled")
  })

  it("exposes the username and the role from the graph", async () => {
    const response = await get("/open", tokenFor("luchi"))
    expect(response.json()).toEqual({ username: "luchi", role: "member" })
  })

  it("lets an admin through and stops a member with 403", async () => {
    expect((await get("/admin", tokenFor("santi"))).statusCode).toBe(200)

    const denied = await get("/admin", tokenFor("luchi"))
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toEqual({ error: "forbidden", message: "Only an admin can do this" })
    expect(logForbidden).toHaveBeenCalledWith("luchi", expect.any(String), "/admin")
  })
})
