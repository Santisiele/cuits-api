import { describe, it, expect, vi, beforeAll } from "vitest"
import Fastify from "fastify"
import swagger from "@fastify/swagger"
import { documentRoute, isPublicRoute, tagFor } from "@helpers/openapi"

await vi.hoisted(async () => {
  const { tmpdir } = await import("os")
  process.env["LOG_ROUTE"] = `${tmpdir()}/cuits-openapi-test-logs`
})

vi.mock("@infrastructure/neo4j/Neo4jDriver.js", () => ({ Neo4jDriver: { instance: { session: () => ({}) }, close: async () => {} } }))

type Operation = {
  summary?: string
  tags?: string[]
  security?: unknown[]
  requestBody?: unknown
  parameters?: { name: string; in: string; schema?: unknown }[]
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>
}

let paths: Record<string, Record<string, Operation>> = {}
let refs: string[] = []
let components: Record<string, unknown> = {}

beforeAll(async () => {
  const { schemas } = await import("@schemas.js")
  const server = Fastify()
  for (const schema of Object.values(schemas)) server.addSchema(schema)
  await server.register(swagger, { openapi: { info: { title: "CUIT API", version: "1.0.0" } }, transform: documentRoute })
  await server.register((await import("@routes/auth")).default)
  for (const name of ["cuit", "graph", "sources", "trustLevels", "users", "research", "birthdays", "crm", "activity"]) {
    await server.register((await import(`../routes/${name}.ts`)).default)
  }
  await server.ready()
  const spec = server.swagger() as { paths: typeof paths; components?: { schemas?: Record<string, unknown> } }
  paths = spec.paths
  components = spec.components?.schemas ?? {}
  refs = [...JSON.stringify(spec).matchAll(/"\$ref":"([^"]+)"/g)].map((match) => match[1]!)
})

function operations(): [string, Operation][] {
  return Object.entries(paths).flatMap(([url, ops]) => Object.entries(ops).map(([method, op]) => [`${method.toUpperCase()} ${url}`, op] as [string, Operation]))
}

describe("the API docs", () => {
  it("describe every route with a summary and a known section", () => {
    for (const [name, op] of operations()) {
      expect(op.summary, name).toBeTruthy()
      expect(op.tags?.length, name).toBe(1)
      expect(op.tags?.[0], name).not.toBe("Other")
    }
  })

  it("give every route a success response with its shape", () => {
    for (const [name, op] of operations()) {
      const success = Object.entries(op.responses ?? {}).filter(([code]) => code.startsWith("2"))
      expect(success.length, name).toBeGreaterThan(0)
      for (const [code, response] of success) expect(response.content?.["application/json"]?.schema, `${name} ${code}`).toBeDefined()
    }
  })

  it("say which routes need a session and answer 401 without one", () => {
    for (const [name, op] of operations()) {
      const [method, url] = name.split(" ") as [string, string]
      if (isPublicRoute(method, url)) expect(op.security, name).toEqual([])
      else expect(op.responses?.["401"], name).toBeDefined()
    }
  })

  it("declare every path parameter, and a body for every write that takes one", () => {
    for (const [name, op] of operations()) {
      const url = name.split(" ")[1]!
      for (const param of url.match(/\{(\w+)\}/g) ?? []) {
        const declared = op.parameters?.find((p) => p.in === "path" && `{${p.name}}` === param)
        expect(declared?.schema, `${name} ${param}`).toBeDefined()
      }
    }
    const withBody = operations().filter(([name]) => /^(POST|PATCH) /.test(name) && !/\/(restore|reopen|logout)$/.test(name))
    for (const [name, op] of withBody) expect(op.requestBody, name).toBeDefined()
  })

  it("point every reference at a schema that exists", () => {
    for (const ref of refs) {
      const name = ref.replace("#/components/schemas/", "")
      expect(components[name], ref).toBeDefined()
    }
  })
})

describe("documentRoute", () => {
  it("groups routes by their first path segment", () => {
    expect(tagFor("/crm/agenda")).toBe("CRM")
    expect(tagFor("/nodes/{taxId}/sources")).toBe("Sources")
    expect(tagFor("/cuit/{cuit}")).toBe("CUIT")
    expect(tagFor("/nowhere")).toBe("Other")
  })

  it("leaves login and logout open and asks a session everywhere else", () => {
    expect(isPublicRoute("POST", "/auth/login")).toBe(true)
    expect(isPublicRoute(["POST"], "/auth/logout")).toBe(true)
    expect(isPublicRoute("GET", "/auth/me")).toBe(false)
  })
})
