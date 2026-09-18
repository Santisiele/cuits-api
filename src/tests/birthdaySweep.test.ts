import { describe, it, expect } from "vitest"
import {
  DAILY_LIMIT,
  budgetFor,
  currentDay,
  emptyState,
  markConsultation,
  markMiss,
  restoreState,
  skipList,
  type ScrapeState,
} from "@helpers/birthdaySweep"

const TODAY = "2026-09-17"

function stored(state: Partial<ScrapeState>): string {
  return JSON.stringify(state)
}

describe("currentDay", () => {
  it("pads month and day to two digits", () => {
    expect(currentDay(new Date(2026, 0, 5))).toBe("2026-01-05")
  })

  it("formats a two-digit month and day unchanged", () => {
    expect(currentDay(new Date(2026, 11, 31))).toBe("2026-12-31")
  })
})

describe("restoreState", () => {
  it("starts empty when there is no file yet", () => {
    expect(restoreState(null, TODAY)).toEqual(emptyState(TODAY))
  })

  it("keeps the count when the stored day is today", () => {
    const state = restoreState(stored({ day: TODAY, consultedToday: 47, misses: {} }), TODAY)
    expect(state.consultedToday).toBe(47)
  })

  it("resets the count when the day rolled over", () => {
    const state = restoreState(stored({ day: "2026-09-16", consultedToday: 100, misses: {} }), TODAY)
    expect(state.consultedToday).toBe(0)
  })

  it("keeps the misses across a day rollover so quota is not respent on them", () => {
    const state = restoreState(
      stored({ day: "2026-09-16", consultedToday: 100, misses: { "20111111119": "2026-09-16" } }),
      TODAY
    )
    expect(state.misses).toEqual({ "20111111119": "2026-09-16" })
  })

  it("adopts today as the day after a rollover", () => {
    const state = restoreState(stored({ day: "2026-09-16", consultedToday: 100, misses: {} }), TODAY)
    expect(state.day).toBe(TODAY)
  })

  it("throws on a corrupt file instead of silently resetting the quota", () => {
    expect(() => restoreState("{ not json", TODAY)).toThrow()
  })

  it("treats a missing count as zero", () => {
    expect(restoreState(stored({ day: TODAY, misses: {} }), TODAY).consultedToday).toBe(0)
  })

  it("refuses a negative count", () => {
    expect(restoreState(stored({ day: TODAY, consultedToday: -5, misses: {} }), TODAY).consultedToday).toBe(0)
  })

  it("tolerates a file with no misses key", () => {
    expect(restoreState(stored({ day: TODAY, consultedToday: 1 }), TODAY).misses).toEqual({})
  })
})

describe("budgetFor", () => {
  it("gives the whole request when nothing has been spent", () => {
    expect(budgetFor(100, emptyState(TODAY))).toBe(100)
  })

  it("caps the request at what is left of the day", () => {
    expect(budgetFor(100, { day: TODAY, consultedToday: 80, misses: {} })).toBe(20)
  })

  it("gives zero once the daily limit is reached", () => {
    expect(budgetFor(100, { day: TODAY, consultedToday: DAILY_LIMIT, misses: {} })).toBe(0)
  })

  it("never goes negative if the counter somehow overshot", () => {
    expect(budgetFor(100, { day: TODAY, consultedToday: 140, misses: {} })).toBe(0)
  })

  it("honours a request smaller than the remaining quota", () => {
    expect(budgetFor(3, emptyState(TODAY))).toBe(3)
  })

  it("respects a lower limit passed in", () => {
    expect(budgetFor(100, emptyState(TODAY), 10)).toBe(10)
  })

  it("defaults the limit to a hundred a day", () => {
    expect(DAILY_LIMIT).toBe(100)
    expect(budgetFor(999, emptyState(TODAY))).toBe(100)
  })
})

describe("skipList", () => {
  it("is empty for a fresh state", () => {
    expect(skipList(emptyState(TODAY))).toEqual([])
  })

  it("names every CUIT already tried without luck", () => {
    const state: ScrapeState = {
      day: TODAY,
      consultedToday: 2,
      misses: { "20111111119": TODAY, "27222222224": TODAY },
    }
    expect(skipList(state).sort()).toEqual(["20111111119", "27222222224"])
  })
})

describe("markConsultation", () => {
  it("counts one consultation against the day", () => {
    expect(markConsultation(emptyState(TODAY)).consultedToday).toBe(1)
  })

  it("accumulates across calls", () => {
    const state = emptyState(TODAY)
    markConsultation(state)
    markConsultation(state)
    expect(state.consultedToday).toBe(2)
  })
})

describe("markMiss", () => {
  it("records the miss under the day it happened", () => {
    expect(markMiss(emptyState(TODAY), "20111111119").misses["20111111119"]).toBe(TODAY)
  })

  it("does not spend quota by itself", () => {
    expect(markMiss(emptyState(TODAY), "20111111119").consultedToday).toBe(0)
  })

  it("puts the miss into the skip list for the next run", () => {
    const state = markMiss(emptyState(TODAY), "20111111119")
    expect(skipList(state)).toContain("20111111119")
  })
})
