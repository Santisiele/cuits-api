import { describe, it, expect, vi, beforeEach } from "vitest"
import type { BirthdayCandidate, BirthdayIdentity } from "@domain/entities"
import type { ScrapeState } from "@helpers/birthdaySweep"
import { emptyState } from "@helpers/birthdaySweep"
import {
  BirthdaySweepService,
  MAX_CONSECUTIVE_FAILURES,
  type SweepEvent,
} from "@application/BirthdaySweepService"

const TODAY = "2026-09-18"

function candidate(taxId: string, businessName = `Persona ${taxId}`): BirthdayCandidate {
  return { taxId, businessName, priority: 0 }
}

function makeRepo() {
  return {
    countPeopleWithoutBirthday: vi.fn(async () => 965),
    findBirthdayCandidates: vi.fn(async (_skip: string[], _limit: number): Promise<BirthdayCandidate[]> => []),
    setBirthday: vi.fn(async (_taxId: string, _birthday: string): Promise<void> => undefined),
  }
}

function makeProvider(birthdays: Record<string, string | null | Error> = {}) {
  return {
    searchDocument: vi.fn(async (taxId: string): Promise<BirthdayIdentity | null> =>
      taxId in birthdays || taxId.startsWith("2") ? { taxId, businessName: `NOSIS ${taxId}` } : null
    ),
    fetchBirthday: vi.fn(async (taxId: string, _name: string): Promise<string | null> => {
      const answer = birthdays[taxId]
      if (answer instanceof Error) throw answer
      return answer ?? null
    }),
  }
}

function makeHooks() {
  const events: SweepEvent[] = []
  const snapshots: number[] = []
  return {
    events,
    snapshots,
    hooks: {
      persist: vi.fn((state: ScrapeState) => {
        snapshots.push(state.consultedToday)
      }),
      wait: vi.fn(async () => undefined),
      report: vi.fn((event: SweepEvent) => {
        events.push(event)
      }),
    },
  }
}

describe("BirthdaySweepService", () => {
  let repo: ReturnType<typeof makeRepo>
  let service: BirthdaySweepService
  let state: ScrapeState

  beforeEach(() => {
    repo = makeRepo()
    service = new BirthdaySweepService(repo)
    state = emptyState(TODAY)
  })

  describe("choosing who to consult", () => {
    it("asks the repository how many are still pending", async () => {
      expect(await service.countPending()).toBe(965)
    })

    it("passes the budget as the limit", async () => {
      await service.findCandidates(state, 40)
      expect(repo.findBirthdayCandidates).toHaveBeenCalledWith([], 40)
    })

    it("skips everyone already tried without luck", async () => {
      state.misses["20111111119"] = "2026-09-17"
      await service.findCandidates(state, 40)
      expect(repo.findBirthdayCandidates).toHaveBeenCalledWith(["20111111119"], 40)
    })
  })

  describe("a birthday found", () => {
    it("writes it to the graph under the candidate's CUIT", async () => {
      const provider = makeProvider({ "20111111119": "30/07/2004" })
      await service.sweep(provider, [candidate("20111111119")], state, makeHooks().hooks)
      expect(repo.setBirthday).toHaveBeenCalledWith("20111111119", "30/07/2004")
    })

    it("asks Nosis with the name Nosis itself resolved, not the one in the base", async () => {
      const provider = makeProvider({ "20111111119": "30/07/2004" })
      await service.sweep(provider, [candidate("20111111119", "Nombre Mal Escrito")], state, makeHooks().hooks)
      expect(provider.fetchBirthday).toHaveBeenCalledWith("20111111119", "NOSIS 20111111119")
    })

    it("charges one consultation against the day", async () => {
      const provider = makeProvider({ "20111111119": "30/07/2004" })
      await service.sweep(provider, [candidate("20111111119")], state, makeHooks().hooks)
      expect(state.consultedToday).toBe(1)
    })

    it("saves the count the moment the consultation is spent", async () => {
      const provider = makeProvider({ "20111111119": "30/07/2004" })
      const { hooks, snapshots } = makeHooks()
      await service.sweep(provider, [candidate("20111111119")], state, hooks)
      expect(snapshots).toContain(1)
    })

    it("reports the date it found", async () => {
      const provider = makeProvider({ "20111111119": "30/07/2004" })
      const { hooks, events } = makeHooks()
      await service.sweep(provider, [candidate("20111111119")], state, hooks)
      expect(events).toContainEqual(expect.objectContaining({ kind: "updated", birthday: "30/07/2004" }))
    })

    it("does not record a miss", async () => {
      const provider = makeProvider({ "20111111119": "30/07/2004" })
      await service.sweep(provider, [candidate("20111111119")], state, makeHooks().hooks)
      expect(state.misses).toEqual({})
    })
  })

  describe("a CUIT Nosis does not know", () => {
    const unknown = candidate("30999999999")

    it("spends no consultation, since no report was opened", async () => {
      await service.sweep(makeProvider(), [unknown], state, makeHooks().hooks)
      expect(state.consultedToday).toBe(0)
    })

    it("never asks for the birthday", async () => {
      const provider = makeProvider()
      await service.sweep(provider, [unknown], state, makeHooks().hooks)
      expect(provider.fetchBirthday).not.toHaveBeenCalled()
    })

    it("is recorded as a miss so the next run skips it", async () => {
      await service.sweep(makeProvider(), [unknown], state, makeHooks().hooks)
      expect(state.misses[unknown.taxId]).toBe(TODAY)
    })

    it("is reported as not found", async () => {
      const { hooks, events } = makeHooks()
      await service.sweep(makeProvider(), [unknown], state, hooks)
      expect(events[0]).toMatchObject({ kind: "not_found" })
    })
  })

  describe("a report with no birth date", () => {
    it("still charges the consultation", async () => {
      await service.sweep(makeProvider({ "20111111119": null }), [candidate("20111111119")], state, makeHooks().hooks)
      expect(state.consultedToday).toBe(1)
    })

    it("is recorded as a miss", async () => {
      await service.sweep(makeProvider({ "20111111119": null }), [candidate("20111111119")], state, makeHooks().hooks)
      expect(state.misses["20111111119"]).toBe(TODAY)
    })

    it("writes nothing to the graph", async () => {
      await service.sweep(makeProvider({ "20111111119": null }), [candidate("20111111119")], state, makeHooks().hooks)
      expect(repo.setBirthday).not.toHaveBeenCalled()
    })
  })

  describe("a consultation that fails", () => {
    it("counts against the quota, since it may have reached Nosis", async () => {
      const provider = makeProvider({ "20111111119": new Error("timeout") })
      await service.sweep(provider, [candidate("20111111119")], state, makeHooks().hooks)
      expect(state.consultedToday).toBe(1)
    })

    it("reports the reason", async () => {
      const { hooks, events } = makeHooks()
      await service.sweep(makeProvider({ "20111111119": new Error("timeout") }), [candidate("20111111119")], state, hooks)
      expect(events[0]).toMatchObject({ kind: "failed", message: "timeout" })
    })

    it("charges a consultation once when saving the birthday fails", async () => {
      repo.setBirthday.mockRejectedValueOnce(new Error("Aura down"))
      const provider = makeProvider({ "20111111119": "30/07/2004" })
      await service.sweep(provider, [candidate("20111111119")], state, makeHooks().hooks)
      expect(state.consultedToday).toBe(1)
    })

    it("reports a failed save as a failure", async () => {
      repo.setBirthday.mockRejectedValueOnce(new Error("Aura down"))
      const { hooks, events } = makeHooks()
      await service.sweep(makeProvider({ "20111111119": "30/07/2004" }), [candidate("20111111119")], state, hooks)
      expect(events[0]).toMatchObject({ kind: "failed", message: "Aura down" })
    })

    it("moves on to the next candidate", async () => {
      const provider = makeProvider({ "20111111119": new Error("timeout"), "20222222228": "01/01/1950" })
      await service.sweep(provider, [candidate("20111111119"), candidate("20222222228")], state, makeHooks().hooks)
      expect(repo.setBirthday).toHaveBeenCalledWith("20222222228", "01/01/1950")
    })

    it(`stops after ${MAX_CONSECUTIVE_FAILURES} failures in a row`, async () => {
      const failing = ["20111111119", "20222222228", "20333333336", "20444444443"]
      const provider = makeProvider(Object.fromEntries(failing.map((t) => [t, new Error("dead")])))
      const tally = await service.sweep(provider, failing.map((t) => candidate(t)), state, makeHooks().hooks)
      expect(tally.aborted).toBe(true)
      expect(provider.searchDocument).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES)
    })

    it("says why it stopped", async () => {
      const failing = ["20111111119", "20222222228", "20333333336"]
      const provider = makeProvider(Object.fromEntries(failing.map((t) => [t, new Error("dead")])))
      const { hooks, events } = makeHooks()
      await service.sweep(provider, failing.map((t) => candidate(t)), state, hooks)
      expect(events.at(-1)).toEqual({ kind: "aborted", failures: MAX_CONSECUTIVE_FAILURES })
    })

    it("does not stop when a success breaks the streak", async () => {
      const ids = ["20111111119", "20222222228", "20333333336", "20444444443", "20555555550"]
      const provider = makeProvider({
        "20111111119": new Error("x"),
        "20222222228": new Error("x"),
        "20333333336": "01/01/1950",
        "20444444443": new Error("x"),
        "20555555550": new Error("x"),
      })
      const tally = await service.sweep(provider, ids.map((t) => candidate(t)), state, makeHooks().hooks)
      expect(tally.aborted).toBe(false)
      expect(provider.searchDocument).toHaveBeenCalledTimes(5)
    })
  })

  describe("pacing", () => {
    it("waits between consultations but not after the last one", async () => {
      const ids = ["20111111119", "20222222228", "20333333336"]
      const provider = makeProvider(Object.fromEntries(ids.map((t) => [t, "01/01/1950"])))
      const { hooks } = makeHooks()
      await service.sweep(provider, ids.map((t) => candidate(t)), state, hooks)
      expect(hooks.wait).toHaveBeenCalledTimes(2)
    })

    it("does not wait after giving up", async () => {
      const failing = ["20111111119", "20222222228", "20333333336", "20444444443"]
      const provider = makeProvider(Object.fromEntries(failing.map((t) => [t, new Error("dead")])))
      const { hooks } = makeHooks()
      await service.sweep(provider, failing.map((t) => candidate(t)), state, hooks)
      expect(hooks.wait).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES - 1)
    })
  })

  describe("the tally", () => {
    it("adds up every outcome", async () => {
      const provider = makeProvider({ "20111111119": "01/01/1950", "20222222228": null })
      const tally = await service.sweep(
        provider,
        [candidate("20111111119"), candidate("20222222228"), candidate("30999999999")],
        state,
        makeHooks().hooks
      )
      expect(tally).toEqual({ updated: 1, missing: 1, unresolved: 1, searches: 3, aborted: false })
    })

    it("is empty for an empty queue", async () => {
      const tally = await service.sweep(makeProvider(), [], state, makeHooks().hooks)
      expect(tally).toEqual({ updated: 0, missing: 0, unresolved: 0, searches: 0, aborted: false })
    })
  })
})
