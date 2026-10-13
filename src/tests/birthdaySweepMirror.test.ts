import { describe, it, expect, vi } from "vitest"
import type { BirthdaySweepSnapshot } from "@domain/birthdayProgress"
import type { BirthdayIdentity } from "@domain/entities"
import { DAILY_LIMIT, emptyState, type ScrapeState } from "@helpers/birthdaySweep"
import { BirthdaySweepMirror } from "@application/BirthdaySweepMirror"
import { BirthdaySweepService } from "@application/BirthdaySweepService"

const NOW = new Date("2026-10-13T15:00:00.000Z")

function makeRepo() {
  const saved: BirthdaySweepSnapshot[] = []
  return {
    saved,
    saveSweep: vi.fn(async (snapshot: BirthdaySweepSnapshot): Promise<void> => {
      saved.push(snapshot)
    }),
  }
}

function makeMirror(repo: ReturnType<typeof makeRepo>, onError = vi.fn()) {
  return { onError, mirror: new BirthdaySweepMirror(repo, onError, () => NOW) }
}

function state(consultedToday: number, misses: Record<string, string> = {}): ScrapeState {
  return { day: "2026-10-13", consultedToday, misses }
}

describe("BirthdaySweepMirror", () => {
  it("saves the state with the daily limit and the time", async () => {
    const repo = makeRepo()
    const { mirror } = makeMirror(repo)
    mirror.push(state(3, { "20111111119": "2026-10-12" }))
    await mirror.settled()
    expect(repo.saved).toEqual([
      {
        day: "2026-10-13",
        consultedToday: 3,
        dailyLimit: DAILY_LIMIT,
        misses: { "20111111119": "2026-10-12" },
        updatedAt: "2026-10-13T15:00:00.000Z",
      },
    ])
  })

  it("saves what the state was when pushed, not what it became later", async () => {
    const repo = makeRepo()
    const { mirror } = makeMirror(repo)
    const current = state(1)
    mirror.push(current)
    current.consultedToday = 2
    current.misses["20111111119"] = "2026-10-13"
    await mirror.settled()
    expect(repo.saved[0]).toMatchObject({ consultedToday: 1, misses: {} })
  })

  it("saves one push after the other, in order", async () => {
    const repo = makeRepo()
    let release = (): void => undefined
    repo.saveSweep.mockImplementationOnce(
      (snapshot) =>
        new Promise<void>((resolve) => {
          release = () => {
            repo.saved.push(snapshot)
            resolve()
          }
        })
    )
    const { mirror } = makeMirror(repo)
    mirror.push(state(1))
    mirror.push(state(2))
    await Promise.resolve()
    expect(repo.saveSweep).toHaveBeenCalledTimes(1)
    release()
    await mirror.settled()
    expect(repo.saved.map((s) => s.consultedToday)).toEqual([1, 2])
  })

  it("hands a failed save to the error handler without throwing", async () => {
    const repo = makeRepo()
    repo.saveSweep.mockRejectedValueOnce(new Error("Aura down"))
    const { mirror, onError } = makeMirror(repo)
    expect(() => mirror.push(state(1))).not.toThrow()
    await expect(mirror.settled()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(new Error("Aura down"))
  })

  it("keeps saving after a failure", async () => {
    const repo = makeRepo()
    repo.saveSweep.mockRejectedValueOnce(new Error("Aura down"))
    const { mirror } = makeMirror(repo)
    mirror.push(state(1))
    mirror.push(state(2))
    await mirror.settled()
    expect(repo.saved.map((s) => s.consultedToday)).toEqual([2])
  })

  it("uses the real clock by default", async () => {
    const repo = makeRepo()
    const mirror = new BirthdaySweepMirror(repo, vi.fn())
    mirror.push(state(1))
    await mirror.settled()
    expect(Date.parse(repo.saved[0]!.updatedAt)).not.toBeNaN()
  })

  it("never changes the quota a sweep charges, even when every save fails", async () => {
    const repo = makeRepo()
    repo.saveSweep.mockRejectedValue(new Error("Aura down"))
    const { mirror, onError } = makeMirror(repo)
    const written: number[] = []
    const sweepState = emptyState("2026-10-13")
    const provider = {
      searchDocument: async (taxId: string): Promise<BirthdayIdentity | null> => ({ taxId, businessName: "NOSIS" }),
      fetchBirthday: async (): Promise<string | null> => null,
    }
    const service = new BirthdaySweepService({
      countPeopleWithoutBirthday: async () => 0,
      findBirthdayCandidates: async () => [],
      setBirthday: async () => undefined,
    })

    const tally = await service.sweep(
      provider,
      [{ taxId: "20111111119", businessName: "A", priority: 0 }, { taxId: "20222222228", businessName: "B", priority: 0 }],
      sweepState,
      {
        persist: (current) => {
          written.push(current.consultedToday)
          mirror.push(current)
        },
        wait: async () => undefined,
        report: () => undefined,
      }
    )
    await mirror.settled()

    expect(tally).toMatchObject({ missing: 2, searches: 2, aborted: false })
    expect(sweepState.consultedToday).toBe(2)
    expect(written.at(-1)).toBe(2)
    expect(onError).toHaveBeenCalledTimes(written.length)
  })
})
