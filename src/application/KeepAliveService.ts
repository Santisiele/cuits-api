import type { IKeepAliveRepository } from "@ports/interfaces.js"

export const KEEP_ALIVE_INTERVAL_MS = 24 * 60 * 60 * 1000

export type KeepAliveEvent =
  | { kind: "pulsed"; pingedAt: string }
  | { kind: "failed"; message: string }

export interface KeepAliveHooks {
  report(event: KeepAliveEvent): void
}

export class KeepAliveService {
  constructor(private readonly repository: IKeepAliveRepository) {}

  async pulse(hooks: KeepAliveHooks, now: Date = new Date()): Promise<boolean> {
    const pingedAt = now.toISOString()
    try {
      await this.repository.touch(pingedAt)
      hooks.report({ kind: "pulsed", pingedAt })
      return true
    } catch (error) {
      hooks.report({ kind: "failed", message: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  start(hooks: KeepAliveHooks, everyMs: number = KEEP_ALIVE_INTERVAL_MS): () => void {
    void this.pulse(hooks)
    const timer = setInterval(() => void this.pulse(hooks), everyMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
