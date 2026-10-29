import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { schemas } from "@schemas.js"
import type { Role } from "@domain/users"
import { InMemoryUserRepository, plainHasher, storedUser } from "./userFakes"

const state = { repository: new InMemoryUserRepository() }

vi.mock("@infrastructure/neo4j/Neo4jUserRepository.js", () => ({
  Neo4jUserRepository: class {
    findByUsername(username: string) { return state.repository.findByUsername(username) }
    findAll() { return state.repository.findAll() }
    create(...args: Parameters<InMemoryUserRepository["create"]>) { return state.repository.create(...args) }
    update(...args: Parameters<InMemoryUserRepository["update"]>) { return state.repository.update(...args) }
    setPasswordHash(username: string, hash: string) { return state.repository.setPasswordHash(username, hash) }
  },
}))

vi.mock("@infrastructure/auth/BcryptPasswordHasher.js", () => ({
  BcryptPasswordHasher: class {
    hash = plainHasher.hash
    compare = plainHasher.compare
  },
}))

vi.mock("@auth/activityLogger.js", () => ({
  logUserOperation: vi.fn(),
  logForbidden: vi.fn(),
  logLogin: vi.fn(),
  logLoginFailed: vi.fn(),
  logLogout: vi.fn(),
}))

const { default: userRoutes } = await import("@routes/users")
const { default: authRoutes } = await import("@routes/auth")
const { logUserOperation } = await import("@auth/activityLogger.js")

async function buildApp(as: { username: string; role: Role }): Promise<FastifyInstance> {
  const app = Fastify()
  for (const schema of Object.values(schemas)) app.addSchema(schema)
  await app.register(authRoutes)
  await app.register(async (instance) => {
    instance.addHook("preHandler", async (request) => {
      request.username = as.username
      request.role = as.role
    })
    await instance.register(userRoutes)
  })
  await app.ready()
  return app
}

const ADMIN = { username: "santi", role: "admin" as const }
const MEMBER = { username: "luchi", role: "member" as const }
const CREATOR = { username: "sofi", role: "creator" as const }

describe("user routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.repository = new InMemoryUserRepository([
      storedUser(),
      storedUser({ username: "luchi", role: "member" }),
      storedUser({ username: "diego", role: "admin" }),
      storedUser({ username: "sofi", role: "creator" }),
    ])
  })

  it("POST /auth/login answers the role too", async () => {
    const app = await buildApp(ADMIN)
    const response = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "luchi", password: "secret123" } })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ username: "luchi", role: "member" })
    expect(typeof response.json().token).toBe("string")
  })

  it("GET /auth/me answers who is logged in", async () => {
    const app = await buildApp(MEMBER)
    const response = await app.inject({ method: "GET", url: "/auth/me" })
    expect(response.json()).toEqual({ username: "luchi", role: "member" })
  })

  it("PATCH /auth/password changes your own password and logs it", async () => {
    const app = await buildApp(MEMBER)
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/password",
      payload: { currentPassword: "secret123", newPassword: "nueva1234" },
    })

    expect(response.statusCode).toBe(200)
    expect((await state.repository.findByUsername("luchi"))?.passwordHash).toBe("hashed:nueva1234")
    expect(logUserOperation).toHaveBeenCalledWith("luchi", "change_own_password", "luchi")
  })

  it("PATCH /auth/password answers 400, not 401, for a wrong current password", async () => {
    const app = await buildApp(MEMBER)
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/password",
      payload: { currentPassword: "wrong", newPassword: "nueva1234" },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe("wrong_password")
  })

  it("GET /users lists users with every field and no hashes", async () => {
    const app = await buildApp(ADMIN)
    const response = await app.inject({ method: "GET", url: "/users" })

    expect(response.statusCode).toBe(200)
    expect(response.json().users[0]).toEqual({
      username: "santi",
      role: "admin",
      createdAt: "2026-09-29T12:00:00.000Z",
      disabled: false,
      color: null,
    })
  })

  it("every /users route answers 403 to a member", async () => {
    const app = await buildApp(MEMBER)
    const calls = [
      app.inject({ method: "GET", url: "/users" }),
      app.inject({ method: "POST", url: "/users", payload: { username: "flavia", password: "secret123", role: "member" } }),
      app.inject({ method: "PATCH", url: "/users/santi", payload: { disabled: true } }),
      app.inject({ method: "POST", url: "/users/santi/password", payload: { password: "nueva1234" } }),
    ]
    for (const response of await Promise.all(calls)) expect(response.statusCode).toBe(403)
    expect((await state.repository.findByUsername("santi"))?.disabledAt).toBeNull()
  })

  it("POST /users creates a user with 201 and 409 for a taken name", async () => {
    const app = await buildApp(ADMIN)
    const created = await app.inject({ method: "POST", url: "/users", payload: { username: "flavia", password: "secret123", role: "member" } })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ username: "flavia", role: "member", disabled: false })

    const taken = await app.inject({ method: "POST", url: "/users", payload: { username: "Flavia", password: "secret123", role: "member" } })
    expect(taken.statusCode).toBe(409)
    expect(taken.json().error).toBe("username_taken")
  })

  it("POST /users never creates a creator", async () => {
    const app = await buildApp(ADMIN)
    const response = await app.inject({ method: "POST", url: "/users", payload: { username: "flavia", password: "secret123", role: "creator" } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe("invalid_role")
  })

  it("POST /users answers 400 for an invalid password", async () => {
    const app = await buildApp(ADMIN)
    const response = await app.inject({ method: "POST", url: "/users", payload: { username: "flavia", password: "short", role: "member" } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe("invalid_password")
  })

  it("PATCH /users/:username disables a member", async () => {
    const app = await buildApp(ADMIN)
    const disabled = await app.inject({ method: "PATCH", url: "/users/luchi", payload: { disabled: true } })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json().disabled).toBe(true)
  })

  it("PATCH /users/:username answers 403 creator_only when an admin changes an admin, themselves included", async () => {
    const app = await buildApp(ADMIN)
    for (const target of ["santi", "diego"]) {
      const response = await app.inject({ method: "PATCH", url: `/users/${target}`, payload: { role: "member" } })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({ error: "creator_only", message: expect.any(String) })
    }
    const reset = await app.inject({ method: "POST", url: "/users/diego/password", payload: { password: "nueva1234" } })
    expect(reset.statusCode).toBe(403)
    expect(reset.json().error).toBe("creator_only")
    expect((await state.repository.findByUsername("diego"))?.role).toBe("admin")
  })

  it("lets the creator demote, disable and reset an admin", async () => {
    const app = await buildApp(CREATOR)
    const demoted = await app.inject({ method: "PATCH", url: "/users/diego", payload: { role: "member", disabled: true } })
    expect(demoted.statusCode).toBe(200)
    expect(demoted.json()).toMatchObject({ role: "member", disabled: true })
    const reset = await app.inject({ method: "POST", url: "/users/santi/password", payload: { password: "nueva1234" } })
    expect(reset.statusCode).toBe(200)
  })

  it("answers 409 cannot_change_creator to anyone touching the creator", async () => {
    for (const actor of [ADMIN, CREATOR]) {
      const app = await buildApp(actor)
      const patch = await app.inject({ method: "PATCH", url: "/users/sofi", payload: { disabled: true } })
      expect(patch.statusCode).toBe(409)
      expect(patch.json()).toEqual({ error: "cannot_change_creator", message: expect.any(String) })
      const reset = await app.inject({ method: "POST", url: "/users/sofi/password", payload: { password: "nueva1234" } })
      expect(reset.statusCode).toBe(409)
      expect(reset.json().error).toBe("cannot_change_creator")
    }
    expect((await state.repository.findByUsername("sofi"))?.disabledAt).toBeNull()
  })

  it("PATCH /users/:username answers 400 invalid_role for creator", async () => {
    const app = await buildApp(CREATOR)
    const response = await app.inject({ method: "PATCH", url: "/users/luchi", payload: { role: "creator" } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe("invalid_role")
  })

  it("PATCH /users/:username answers 404 for an unknown user", async () => {
    const app = await buildApp(ADMIN)
    const response = await app.inject({ method: "PATCH", url: "/users/nadie", payload: { role: "admin" } })
    expect(response.statusCode).toBe(404)
  })

  it("answers 500 when the graph fails, instead of hiding it", async () => {
    state.repository.findAll = async () => {
      throw new Error("Aura is down")
    }
    const app = await buildApp(ADMIN)
    expect((await app.inject({ method: "GET", url: "/users" })).statusCode).toBe(500)

    state.repository.findByUsername = async () => {
      throw new Error("Aura is down")
    }
    const response = await app.inject({ method: "POST", url: "/users/luchi/password", payload: { password: "nueva1234" } })
    expect(response.statusCode).toBe(500)
  })

  it("POST /users/:username/password resets it", async () => {
    const app = await buildApp(ADMIN)
    const response = await app.inject({ method: "POST", url: "/users/luchi/password", payload: { password: "nueva1234" } })
    expect(response.statusCode).toBe(200)
    expect((await state.repository.findByUsername("luchi"))?.passwordHash).toBe("hashed:nueva1234")
  })
})
