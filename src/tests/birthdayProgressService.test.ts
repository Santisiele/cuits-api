import { describe, it, expect, vi } from "vitest"
import { BirthdayProgressService } from "@application/BirthdayProgressService"
import type { BirthdaySweepSnapshot } from "@domain/birthdayProgress"

function makeRepo(snapshot: BirthdaySweepSnapshot | null) {
  return {
    findSweep: vi.fn(async () => snapshot),
    countPeople: vi.fn(async () => ({ knownPeople: 10, withBirthday: 4 })),
    countBySource: vi.fn(async () => []),
    findNames: vi.fn(async (taxIds: string[]) => taxIds.map((taxId) => ({ taxId, businessName: `N ${taxId}` }))),
    findPending: vi.fn(async (_skip: string[]) => []),
  }
}

const SNAPSHOT: BirthdaySweepSnapshot = {
  day: "2026-10-13",
  consultedToday: 9,
  dailyLimit: 100,
  misses: { "20111111119": "2026-10-13" },
  updatedAt: "2026-10-13T15:00:00.000Z",
}

describe("BirthdayProgressService", () => {
  it("joins the stored sweep with the graph counts using the Buenos Aires day", async () => {
    const repo = makeRepo(SNAPSHOT)
    const service = new BirthdayProgressService(repo, () => new Date("2026-10-14T02:59:00.000Z"))
    const progress = await service.progress()
    expect(progress).toMatchObject({
      missing: 6,
      sweep: { consultedToday: 9 },
      misses: [{ taxId: "20111111119", businessName: "N 20111111119", missedOn: "2026-10-13" }],
    })
    expect(repo.findPending).toHaveBeenCalledWith(["20111111119"])
  })

  it("uses the real clock by default", async () => {
    const progress = await new BirthdayProgressService(makeRepo(null)).progress()
    expect(progress.sweep.dailyLimit).toBe(100)
  })
})
