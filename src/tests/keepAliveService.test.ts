import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  KeepAliveService,
  KEEP_ALIVE_INTERVAL_MS,
  type KeepAliveEvent,
} from "@application/KeepAliveService"

function makeRepo() {
  return { touch: vi.fn(async (_pingedAt: string): Promise<void> => undefined) }
}

function makeHooks() {
  const events: KeepAliveEvent[] = []
  return { events, hooks: { report: (event: KeepAliveEvent) => events.push(event) } }
}

describe("KeepAliveService", () => {
  let repo: ReturnType<typeof makeRepo>
  let service: KeepAliveService

  beforeEach(() => {
    repo = makeRepo()
    service = new KeepAliveService(repo)
  })

  describe("a single pulse", () => {
    it("writes to the graph, since a read may not count as activity", async () => {
      await service.pulse(makeHooks().hooks)
      expect(repo.touch).toHaveBeenCalledTimes(1)
    })

    it("stamps the moment it ran", async () => {
      await service.pulse(makeHooks().hooks, new Date("2026-09-24T12:00:00.000Z"))
      expect(repo.touch).toHaveBeenCalledWith("2026-09-24T12:00:00.000Z")
    })

    it("says it went through", async () => {
      const { hooks, events } = makeHooks()
      await service.pulse(hooks, new Date("2026-09-24T12:00:00.000Z"))
      expect(events).toEqual([{ kind: "pulsed", pingedAt: "2026-09-24T12:00:00.000Z" }])
    })

    it("answers true when it went through", async () => {
      expect(await service.pulse(makeHooks().hooks)).toBe(true)
    })
  })

  describe("when the graph is unreachable", () => {
    beforeEach(() => {
      repo.touch.mockRejectedValue(new Error("Aura down"))
    })

    it("does not throw, so it cannot take the server down", async () => {
      await expect(service.pulse(makeHooks().hooks)).resolves.toBe(false)
    })

    it("reports why it failed", async () => {
      const { hooks, events } = makeHooks()
      await service.pulse(hooks)
      expect(events).toEqual([{ kind: "failed", message: "Aura down" }])
    })
  })

  describe("on a schedule", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("pulses as soon as it starts, without waiting a day", async () => {
      service.start(makeHooks().hooks)
      await vi.advanceTimersByTimeAsync(0)
      expect(repo.touch).toHaveBeenCalledTimes(1)
    })

    it("pulses again after the interval", async () => {
      service.start(makeHooks().hooks)
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS)
      expect(repo.touch).toHaveBeenCalledTimes(2)
    })

    it("keeps pulsing day after day", async () => {
      service.start(makeHooks().hooks)
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS * 3)
      expect(repo.touch).toHaveBeenCalledTimes(4)
    })

    it("keeps going after a failed pulse", async () => {
      repo.touch.mockRejectedValueOnce(new Error("Aura down"))
      service.start(makeHooks().hooks)
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS)
      expect(repo.touch).toHaveBeenCalledTimes(2)
    })

    it("stops when told to", async () => {
      const stop = service.start(makeHooks().hooks)
      await vi.advanceTimersByTimeAsync(0)
      stop()
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS * 2)
      expect(repo.touch).toHaveBeenCalledTimes(1)
    })

    it("leaves two spare tries before Aura's 72 hour limit", () => {
      expect(KEEP_ALIVE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
      expect(KEEP_ALIVE_INTERVAL_MS * 3).toBe(72 * 60 * 60 * 1000)
    })
  })
})
