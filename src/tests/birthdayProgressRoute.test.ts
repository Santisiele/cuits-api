import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { schemas } from "@schemas.js"
import type { Role } from "@domain/users"
import type { BirthdaySweepSnapshot } from "@domain/birthdayProgress"
import { DAILY_LIMIT } from "@helpers/birthdaySweep"

const repo = {
  findSweep: vi.fn(),
  countPeople: vi.fn(),
  countBySource: vi.fn(),
  findNames: vi.fn(),
  findPending: vi.fn(),
}

vi.mock("@infrastructure/neo4j/Neo4jBirthdaySweepRepository.js", () => ({
  Neo4jBirthdaySweepRepository: class {
    findSweep = repo.findSweep
    countPeople = repo.countPeople
    countBySource = repo.countBySource
    findNames = repo.findNames
    findPending = repo.findPending
  },
}))

vi.mock("@auth/activityLogger.js", () => ({
  logForbidden: vi.fn(),
  logBirthdayProgressViewed: vi.fn(),
}))

const { default: birthdayRoutes } = await import("@routes/birthdays")
const { logBirthdayProgressViewed, logForbidden } = await import("@auth/activityLogger.js")

const SNAPSHOT: BirthdaySweepSnapshot = {
  day: "2026-10-13",
  consultedToday: 42,
  dailyLimit: 100,
  misses: { "20111111119": "2026-10-12", "20222222228": "2026-10-13" },
  updatedAt: "2026-10-13T15:00:00.000Z",
}

async function buildApp(role: Role): Promise<FastifyInstance> {
  const app = Fastify()
  for (const schema of Object.values(schemas)) app.addSchema(schema)
  await app.register(async (instance) => {
    instance.addHook("preHandler", async (request) => {
      request.username = "santi"
      request.role = role
    })
    await instance.register(birthdayRoutes)
  })
  await app.ready()
  return app
}

function get(app: FastifyInstance) {
  return app.inject({ method: "GET", url: "/birthdays/progress" })
}

describe("GET /birthdays/progress", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-13T18:00:00.000Z"))
    repo.findSweep.mockResolvedValue(SNAPSHOT)
    repo.countPeople.mockResolvedValue({ knownPeople: 1000, withBirthday: 35 })
    repo.countBySource.mockResolvedValue([{ source: "Bolsa", people: 10, withBirthday: 4, missing: 6 }])
    repo.findNames.mockResolvedValue([
      { taxId: "20111111119", businessName: "Ana" },
      { taxId: "20222222228", businessName: "Beto" },
    ])
    repo.findPending.mockResolvedValue([{ taxId: "20333333336", businessName: "Carla", sources: ["Bolsa", "Crm"] }])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("answers every field to the creator", async () => {
    const response = await get(await buildApp("creator"))
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      knownPeople: 1000,
      withBirthday: 35,
      missing: 965,
      bySource: [{ source: "Bolsa", people: 10, withBirthday: 4, missing: 6 }],
      sweep: { day: "2026-10-13", consultedToday: 42, dailyLimit: 100, updatedAt: "2026-10-13T15:00:00.000Z" },
      misses: [
        { taxId: "20222222228", businessName: "Beto", missedOn: "2026-10-13" },
        { taxId: "20111111119", businessName: "Ana", missedOn: "2026-10-12" },
      ],
      pending: [{ taxId: "20333333336", businessName: "Carla", sources: ["Bolsa", "Crm"] }],
    })
  })

  it("leaves the misses out of the pending query", async () => {
    await get(await buildApp("creator"))
    expect(repo.findPending).toHaveBeenCalledWith(["20111111119", "20222222228"])
    expect(repo.findNames).toHaveBeenCalledWith(["20111111119", "20222222228"])
  })

  it("reads zero consultations once the stored day is over in Buenos Aires", async () => {
    vi.setSystemTime(new Date("2026-10-14T03:00:00.000Z"))
    const response = await get(await buildApp("creator"))
    expect(response.json().sweep).toEqual({
      day: "2026-10-13",
      consultedToday: 0,
      dailyLimit: 100,
      updatedAt: "2026-10-13T15:00:00.000Z",
    })
  })

  it("answers nulls and the default limit before the sweep ever ran", async () => {
    repo.findSweep.mockResolvedValue(null)
    const response = await get(await buildApp("creator"))
    expect(response.json().sweep).toEqual({ day: null, consultedToday: 0, dailyLimit: DAILY_LIMIT, updatedAt: null })
    expect(response.json().misses).toEqual([])
    expect(repo.findPending).toHaveBeenCalledWith([])
  })

  it("logs the visit", async () => {
    await get(await buildApp("creator"))
    expect(logBirthdayProgressViewed).toHaveBeenCalledWith("santi", 965, 1)
  })

  it.each(["admin", "member"] as const)("answers 403 to an %s without reading the graph", async (role) => {
    const response = await get(await buildApp(role))
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe("forbidden")
    expect(logForbidden).toHaveBeenCalled()
    expect(repo.findSweep).not.toHaveBeenCalled()
  })
})
