import { describe, it, expect } from "vitest"
import {
  buildProgress,
  dayIn,
  missedPeople,
  parseMisses,
  sweepStatus,
  toSnapshot,
  type BirthdaySweepSnapshot,
} from "@domain/birthdayProgress"
import { DAILY_LIMIT } from "@helpers/birthdaySweep"

const SNAPSHOT: BirthdaySweepSnapshot = {
  day: "2026-10-13",
  consultedToday: 42,
  dailyLimit: 100,
  misses: { "20111111119": "2026-10-12", "20222222228": "2026-10-13" },
  updatedAt: "2026-10-13T15:00:00.000Z",
}

describe("toSnapshot", () => {
  it("copies the state with the limit and the time", () => {
    const state = { day: "2026-10-13", consultedToday: 3, misses: { "20111111119": "2026-10-13" } as Record<string, string> }
    const snapshot = toSnapshot(state, 100, "2026-10-13T15:00:00.000Z")
    state.misses["20222222228"] = "2026-10-13"
    expect(snapshot).toEqual({
      day: "2026-10-13",
      consultedToday: 3,
      dailyLimit: 100,
      misses: { "20111111119": "2026-10-13" },
      updatedAt: "2026-10-13T15:00:00.000Z",
    })
  })
})

describe("dayIn", () => {
  it("is still the previous day in Buenos Aires before 3 am UTC", () => {
    expect(dayIn(new Date("2026-10-14T02:30:00.000Z"))).toBe("2026-10-13")
  })

  it("turns over at midnight Buenos Aires time", () => {
    expect(dayIn(new Date("2026-10-14T03:00:00.000Z"))).toBe("2026-10-14")
  })

  it("pads month and day", () => {
    expect(dayIn(new Date("2026-01-05T12:00:00.000Z"))).toBe("2026-01-05")
  })

  it("accepts another time zone", () => {
    expect(dayIn(new Date("2026-10-14T02:30:00.000Z"), "UTC")).toBe("2026-10-14")
  })
})

describe("parseMisses", () => {
  it("reads the stored JSON map", () => {
    expect(parseMisses(JSON.stringify({ "20111111119": "2026-10-12" }))).toEqual({ "20111111119": "2026-10-12" })
  })

  it("drops entries that are not dates", () => {
    expect(parseMisses(JSON.stringify({ "20111111119": 5, "20222222228": "2026-10-13" }))).toEqual({
      "20222222228": "2026-10-13",
    })
  })

  it.each([null, undefined, 5, "not json", "[]", "null", JSON.stringify("text")])("is empty for %s", (raw) => {
    expect(parseMisses(raw)).toEqual({})
  })
})

describe("sweepStatus", () => {
  it("is empty with the default limit before the sweep ever ran", () => {
    expect(sweepStatus(null, "2026-10-13")).toEqual({ day: null, consultedToday: 0, dailyLimit: DAILY_LIMIT, updatedAt: null })
  })

  it("shows today's count", () => {
    expect(sweepStatus(SNAPSHOT, "2026-10-13")).toEqual({
      day: "2026-10-13",
      consultedToday: 42,
      dailyLimit: 100,
      updatedAt: "2026-10-13T15:00:00.000Z",
    })
  })

  it("resets the count once the stored day is over", () => {
    expect(sweepStatus(SNAPSHOT, "2026-10-14")).toMatchObject({ day: "2026-10-13", consultedToday: 0 })
  })
})

describe("missedPeople", () => {
  it("puts names on the misses, newest first", () => {
    const names = [
      { taxId: "20111111119", businessName: "Ana" },
      { taxId: "20222222228", businessName: "Beto" },
    ]
    expect(missedPeople(SNAPSHOT.misses, names)).toEqual([
      { taxId: "20222222228", businessName: "Beto", missedOn: "2026-10-13" },
      { taxId: "20111111119", businessName: "Ana", missedOn: "2026-10-12" },
    ])
  })

  it("orders by name within the same day", () => {
    const misses = { "20111111119": "2026-10-13", "20222222228": "2026-10-13" }
    const names = [
      { taxId: "20111111119", businessName: "Zoe" },
      { taxId: "20222222228", businessName: "Ana" },
    ]
    expect(missedPeople(misses, names).map((m) => m.businessName)).toEqual(["Ana", "Zoe"])
  })

  it("leaves the name empty for a CUIT no longer in the graph", () => {
    expect(missedPeople({ "20111111119": "2026-10-12" }, [])).toEqual([
      { taxId: "20111111119", businessName: "", missedOn: "2026-10-12" },
    ])
  })
})

describe("buildProgress", () => {
  const bySource = [{ source: "Bolsa", people: 10, withBirthday: 4, missing: 6 }]
  const pending = [{ taxId: "20333333336", businessName: "Carla", sources: ["Bolsa"] }]

  it("puts every part together", () => {
    expect(
      buildProgress({
        people: { knownPeople: 1000, withBirthday: 35 },
        bySource,
        snapshot: SNAPSHOT,
        names: [{ taxId: "20111111119", businessName: "Ana" }],
        pending,
        today: "2026-10-13",
      })
    ).toEqual({
      knownPeople: 1000,
      withBirthday: 35,
      missing: 965,
      bySource,
      sweep: { day: "2026-10-13", consultedToday: 42, dailyLimit: 100, updatedAt: "2026-10-13T15:00:00.000Z" },
      misses: [
        { taxId: "20222222228", businessName: "", missedOn: "2026-10-13" },
        { taxId: "20111111119", businessName: "Ana", missedOn: "2026-10-12" },
      ],
      pending,
    })
  })

  it("has no misses before the sweep ever ran", () => {
    const progress = buildProgress({
      people: { knownPeople: 0, withBirthday: 0 },
      bySource: [],
      snapshot: null,
      names: [],
      pending: [],
      today: "2026-10-13",
    })
    expect(progress.misses).toEqual([])
    expect(progress.sweep.day).toBeNull()
  })
})
