import type { IBirthdayProgressRepository } from "@ports/interfaces.js"
import { buildProgress, dayIn, type BirthdayProgress } from "@domain/birthdayProgress.js"

export class BirthdayProgressService {
  constructor(
    private readonly repository: IBirthdayProgressRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async progress(): Promise<BirthdayProgress> {
    const snapshot = await this.repository.findSweep()
    const missed = Object.keys(snapshot?.misses ?? {})
    const [people, bySource, names, pending] = await Promise.all([
      this.repository.countPeople(),
      this.repository.countBySource(),
      this.repository.findNames(missed),
      this.repository.findPending(missed),
    ])
    return buildProgress({ people, bySource, snapshot, names, pending, today: dayIn(this.now()) })
  }
}
