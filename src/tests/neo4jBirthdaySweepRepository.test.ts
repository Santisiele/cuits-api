import { describe, it, expect, vi, beforeEach } from "vitest"
import neo4j from "neo4j-driver"

const state = {
  rows: [] as Record<string, unknown>[],
  calls: [] as { query: string; params: Record<string, unknown> }[],
}

vi.mock("@infrastructure/neo4j/Neo4jDriver.js", () => ({
  Neo4jDriver: {
    instance: {
      session: () => ({
        run: async (query: string, params: Record<string, unknown> = {}) => {
          state.calls.push({ query, params })
          return { records: state.rows.map((row) => ({ get: (key: string) => row[key] })) }
        },
        close: async () => {},
      }),
    },
  },
}))

const { Neo4jBirthdaySweepRepository } = await import("@infrastructure/neo4j/Neo4jBirthdaySweepRepository")
const { Queries } = await import("@infrastructure/neo4j/queries")

const repository = new Neo4jBirthdaySweepRepository()

describe("Neo4jBirthdaySweepRepository", () => {
  beforeEach(() => {
    state.rows = []
    state.calls = []
  })

  it("stores the sweep with integers and the misses as JSON", async () => {
    await repository.saveSweep({
      day: "2026-10-13",
      consultedToday: 7,
      dailyLimit: 100,
      misses: { "20111111119": "2026-10-12" },
      updatedAt: "2026-10-13T15:00:00.000Z",
    })

    expect(state.calls).toEqual([
      {
        query: Queries.SAVE_BIRTHDAY_SWEEP,
        params: {
          day: "2026-10-13",
          consultedToday: neo4j.int(7),
          dailyLimit: neo4j.int(100),
          misses: JSON.stringify({ "20111111119": "2026-10-12" }),
          updatedAt: "2026-10-13T15:00:00.000Z",
        },
      },
    ])
  })

  it("reads the stored sweep back with integers converted and misses parsed", async () => {
    state.rows = [
      {
        day: "2026-10-13",
        consultedToday: neo4j.int(7),
        dailyLimit: neo4j.int(100),
        misses: JSON.stringify({ "20111111119": "2026-10-12" }),
        updatedAt: "2026-10-13T15:00:00.000Z",
      },
    ]
    expect(await repository.findSweep()).toEqual({
      day: "2026-10-13",
      consultedToday: 7,
      dailyLimit: 100,
      misses: { "20111111119": "2026-10-12" },
      updatedAt: "2026-10-13T15:00:00.000Z",
    })
  })

  it("reads damaged sweep fields as empty", async () => {
    state.rows = [{ day: null, consultedToday: 3, dailyLimit: "x", misses: null, updatedAt: 5 }]
    expect(await repository.findSweep()).toEqual({ day: "", consultedToday: 3, dailyLimit: 0, misses: {}, updatedAt: "" })
  })

  it("answers null when the sweep never ran", async () => {
    expect(await repository.findSweep()).toBeNull()
  })

  it("counts known people and those with a birthday", async () => {
    state.rows = [{ knownPeople: neo4j.int(1000), withBirthday: neo4j.int(35) }]
    expect(await repository.countPeople()).toEqual({ knownPeople: 1000, withBirthday: 35 })
    expect(state.calls[0]?.query).toBe(Queries.COUNT_KNOWN_PEOPLE_BIRTHDAYS)
  })

  it("counts zero people on an empty answer", async () => {
    expect(await repository.countPeople()).toEqual({ knownPeople: 0, withBirthday: 0 })
  })

  it("reads the per-source counts", async () => {
    state.rows = [{ source: "Bolsa", people: neo4j.int(10), withBirthday: neo4j.int(4), missing: neo4j.int(6) }]
    expect(await repository.countBySource()).toEqual([{ source: "Bolsa", people: 10, withBirthday: 4, missing: 6 }])
  })

  it("looks up the names of the given CUITs", async () => {
    state.rows = [{ taxId: "20111111119", businessName: "Ana" }]
    expect(await repository.findNames(["20111111119"])).toEqual([{ taxId: "20111111119", businessName: "Ana" }])
    expect(state.calls).toEqual([{ query: Queries.FIND_CUIT_NAMES, params: { taxIds: ["20111111119"] } }])
  })

  it("skips the name lookup when there is nothing to look up", async () => {
    expect(await repository.findNames([])).toEqual([])
    expect(state.calls).toEqual([])
  })

  it("lists pending people skipping the misses", async () => {
    state.rows = [
      { taxId: "20333333336", businessName: "Carla", sources: ["Bolsa", null] },
      { taxId: "20444444443", businessName: "Dani", sources: null },
    ]
    expect(await repository.findPending(["20111111119"])).toEqual([
      { taxId: "20333333336", businessName: "Carla", sources: ["Bolsa"] },
      { taxId: "20444444443", businessName: "Dani", sources: [] },
    ])
    expect(state.calls).toEqual([{ query: Queries.FIND_PEOPLE_PENDING_BIRTHDAY, params: { skip: ["20111111119"] } }])
  })
})
