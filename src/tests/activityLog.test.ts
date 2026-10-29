import { describe, it, expect, vi } from "vitest"
import Fastify from "fastify"
import { ActivityLogService } from "@application/ActivityLogService"
import { matchesActivity, parseActivityFilters, parseActivityLine } from "@domain/activityLog"

vi.mock("@auth/activityLogger.js", () => ({ LOG_FILE: "unused.log", logForbidden: vi.fn() }))

const { default: activityRoutes } = await import("@routes/activity")

const LINES = [
  JSON.stringify({ level: 30, time: Date.UTC(2026, 9, 29, 12), pid: 1, hostname: "h", event: "login", username: "luchi", ip: "1.1.1.1", message: "luchi logged in" }),
  "not json",
  JSON.stringify({ level: 30, time: Date.UTC(2026, 9, 29, 13), event: "crm_operation", username: "sol", operation: "create", entityType: "Action", entityId: "a1", doneBy: "Raul", message: "x" }),
  JSON.stringify({ level: 40, time: Date.UTC(2026, 9, 29, 14), event: "forbidden", username: "sol", url: "/users", message: "x" }),
  JSON.stringify({ level: 50, time: Date.UTC(2026, 9, 29, 15), event: "web_research", username: "luchi", status: "failed", message: "x" }),
  JSON.stringify({ level: 30, time: "bad", event: "login" }),
]

async function* lines(): AsyncIterable<string> {
  for (const line of LINES) yield line
}

describe("parseActivityLine", () => {
  it("keeps the time, level, event, user and the event's own fields, not pino's", () => {
    expect(parseActivityLine(LINES[0]!)).toEqual({
      time: "2026-10-29T12:00:00.000Z",
      level: "info",
      event: "login",
      username: "luchi",
      details: { ip: "1.1.1.1" },
    })
    expect(parseActivityLine(LINES[3]!)?.level).toBe("warn")
    expect(parseActivityLine(LINES[4]!)?.level).toBe("error")
  })

  it("skips lines that are not log entries", () => {
    expect(parseActivityLine("not json")).toBeNull()
    expect(parseActivityLine(LINES[5]!)).toBeNull()
    expect(parseActivityLine("4")).toBeNull()
  })
})

describe("filters", () => {
  it("reads the query safely", () => {
    expect(parseActivityFilters({})).toEqual({ limit: 200, before: null, username: null, event: null })
    expect(parseActivityFilters({ limit: "5000", before: "2026-10-29T13:00:00Z", username: " SOL ", event: "login" })).toEqual({
      limit: 1000,
      before: "2026-10-29T13:00:00.000Z",
      username: "sol",
      event: "login",
    })
    expect(parseActivityFilters({ limit: "x", before: "ayer" })).toMatchObject({ limit: 200, before: null })
  })

  it("matches by time, user and event", () => {
    const entry = parseActivityLine(LINES[2]!)!
    expect(matchesActivity(entry, parseActivityFilters({ username: "SOL" }))).toBe(true)
    expect(matchesActivity(entry, parseActivityFilters({ username: "luchi" }))).toBe(false)
    expect(matchesActivity(entry, parseActivityFilters({ event: "login" }))).toBe(false)
    expect(matchesActivity(entry, parseActivityFilters({ before: "2026-10-29T13:00:00Z" }))).toBe(false)
  })
})

describe("ActivityLogService", () => {
  it("answers the newest first, up to the limit, saying when there is more", async () => {
    const page = await new ActivityLogService(lines).read(parseActivityFilters({ limit: "2" }))
    expect(page.entries.map((entry) => entry.event)).toEqual(["web_research", "forbidden"])
    expect(page.hasMore).toBe(true)
  })

  it("pages back from a time", async () => {
    const page = await new ActivityLogService(lines).read(parseActivityFilters({ limit: "2", before: "2026-10-29T14:00:00Z" }))
    expect(page.entries.map((entry) => entry.event)).toEqual(["crm_operation", "login"])
    expect(page.hasMore).toBe(false)
  })
})

describe("GET /activity", () => {
  async function app(role: "creator" | "admin") {
    const server = Fastify()
    await server.register(async (instance) => {
      instance.addHook("preHandler", async (request) => {
        request.username = "admin"
        request.role = role
      })
      await instance.register(activityRoutes, { lines })
    })
    return server
  }

  it("is only for the creator", async () => {
    expect((await (await app("admin")).inject({ method: "GET", url: "/activity" })).statusCode).toBe(403)
  })

  it("answers every field, details included", async () => {
    const response = await (await app("creator")).inject({ method: "GET", url: "/activity?event=crm_operation" })
    expect(response.json()).toEqual({
      entries: [
        {
          time: "2026-10-29T13:00:00.000Z",
          level: "info",
          event: "crm_operation",
          username: "sol",
          details: { operation: "create", entityType: "Action", entityId: "a1", doneBy: "Raul" },
        },
      ],
      hasMore: false,
    })
  })
})
