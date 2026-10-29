import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify from "fastify"
import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
import { DOCS_REALM, docsGuard, parseBasicAuth } from "@middleware/docsGuard"
import type { AuthResult } from "@auth/AuthService"

const onFailed = vi.fn()
const onViewed = vi.fn()

async function login(username: string, password: string): Promise<AuthResult> {
  if (password !== "secreta") return { success: false, reason: "invalid_credentials" }
  return { success: true, token: "t", username, role: username === "sol" ? "member" : "admin" }
}

async function app() {
  const server = Fastify()
  await server.register(swagger, { openapi: { info: { title: "CUIT API", version: "1.0.0" } } })
  await server.register(swaggerUi, { routePrefix: "/docs", uiHooks: { onRequest: docsGuard({ login, onFailed, onViewed }) } })
  server.get("/ping", { schema: { summary: "Ping", response: { 200: { type: "string" } } } }, async () => "pong")
  await server.ready()
  return server
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

describe("the API docs login", () => {
  beforeEach(() => {
    onFailed.mockReset()
    onViewed.mockReset()
  })

  it("asks the browser to log in before showing the docs or the spec", async () => {
    const server = await app()
    for (const url of ["/docs", "/docs/json", "/docs/static/index.html"]) {
      const response = await server.inject({ method: "GET", url })
      expect(response.statusCode, url).toBe(401)
      expect(response.headers["www-authenticate"], url).toBe(DOCS_REALM)
    }
  })

  it("logs a wrong password like a failed login", async () => {
    const server = await app()
    const response = await server.inject({ method: "GET", url: "/docs/json", headers: { authorization: basic("admin", "mal") } })
    expect(response.statusCode).toBe(401)
    expect(onFailed).toHaveBeenCalledWith("admin", "127.0.0.1", "invalid_credentials")
  })

  it("lets admins in and logs that they opened the spec", async () => {
    const server = await app()
    const response = await server.inject({ method: "GET", url: "/docs/json", headers: { authorization: basic("admin", "secreta") } })
    expect(response.statusCode).toBe(200)
    expect(response.json().paths["/ping"]).toBeDefined()
    expect(onViewed).toHaveBeenCalledWith("admin", "127.0.0.1")
  })

  it("keeps members out", async () => {
    const server = await app()
    const response = await server.inject({ method: "GET", url: "/docs/json", headers: { authorization: basic("sol", "secreta") } })
    expect(response.statusCode).toBe(403)
  })
})

describe("parseBasicAuth", () => {
  it("reads the user and a password that may hold colons", () => {
    expect(parseBasicAuth(basic("admin", "a:b"))).toEqual({ username: "admin", password: "a:b" })
  })

  it("ignores anything that is not basic auth", () => {
    expect(parseBasicAuth(undefined)).toBeNull()
    expect(parseBasicAuth("Bearer x")).toBeNull()
    expect(parseBasicAuth(`Basic ${Buffer.from("sinclave").toString("base64")}`)).toBeNull()
  })
})
