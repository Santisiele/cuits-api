import type { IBirthdaySweepMirror } from "@ports/interfaces.js"
import { DAILY_LIMIT, type ScrapeState } from "@helpers/birthdaySweep.js"
import { toSnapshot } from "@domain/birthdayProgress.js"

export class BirthdaySweepMirror {
  private last: Promise<void> = Promise.resolve()

  constructor(
    private readonly repository: IBirthdaySweepMirror,
    private readonly onError: (error: unknown) => void,
    private readonly now: () => Date = () => new Date()
  ) {}

  push(state: ScrapeState): void {
    const snapshot = toSnapshot(state, DAILY_LIMIT, this.now().toISOString())
    this.last = this.last.then(() => this.repository.saveSweep(snapshot)).catch(this.onError)
  }

  settled(): Promise<void> {
    return this.last
  }
}
