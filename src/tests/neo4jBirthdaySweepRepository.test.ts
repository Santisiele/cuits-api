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
})
