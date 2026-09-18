import type { IBirthdayProvider, IBirthdaySweepRepository } from "@ports/interfaces.js"
import type { BirthdayCandidate } from "@domain/entities.js"
import { markConsultation, markMiss, skipList, type ScrapeState } from "@helpers/birthdaySweep.js"

export const MAX_CONSECUTIVE_FAILURES = 3

interface Position {
  candidate: BirthdayCandidate
  position: number
  total: number
}

export type SweepEvent =
  | ({ kind: "updated"; birthday: string } & Position)
  | ({ kind: "not_found" } & Position)
  | ({ kind: "no_date" } & Position)
  | ({ kind: "failed"; message: string } & Position)
  | { kind: "aborted"; failures: number }

export interface SweepHooks {
  persist(state: ScrapeState): void
  wait(): Promise<void>
  report(event: SweepEvent): void
}

export interface SweepTally {
  updated: number
  missing: number
  unresolved: number
  searches: number
  aborted: boolean
}

export class BirthdaySweepService {
  constructor(private readonly repository: IBirthdaySweepRepository) {}

  countPending(): Promise<number> {
    return this.repository.countPeopleWithoutBirthday()
  }

  findCandidates(state: ScrapeState, budget: number): Promise<BirthdayCandidate[]> {
    return this.repository.findBirthdayCandidates(skipList(state), budget)
  }

  async sweep(
    provider: IBirthdayProvider,
    candidates: BirthdayCandidate[],
    state: ScrapeState,
    hooks: SweepHooks
  ): Promise<SweepTally> {
    const tally: SweepTally = { updated: 0, missing: 0, unresolved: 0, searches: 0, aborted: false }
    const total = candidates.length
    let consecutiveFailures = 0

    for (const [index, candidate] of candidates.entries()) {
      const at: Position = { candidate, position: index + 1, total }
      let charged = false

      try {
        tally.searches++
        const identity = await provider.searchDocument(candidate.taxId)

        if (!identity) {
          tally.unresolved++
          markMiss(state, candidate.taxId)
          hooks.persist(state)
          hooks.report({ kind: "not_found", ...at })
        } else {
          const birthday = await provider.fetchBirthday(identity.taxId, identity.businessName)
          markConsultation(state)
          charged = true
          hooks.persist(state)

          if (!birthday) {
            tally.missing++
            markMiss(state, candidate.taxId)
            hooks.persist(state)
            hooks.report({ kind: "no_date", ...at })
          } else {
            await this.repository.setBirthday(candidate.taxId, birthday)
            tally.updated++
            hooks.report({ kind: "updated", birthday, ...at })
          }
        }
        consecutiveFailures = 0
      } catch (error) {
        if (!charged) markConsultation(state)
        hooks.persist(state)
        consecutiveFailures++
        hooks.report({ kind: "failed", message: error instanceof Error ? error.message : String(error), ...at })

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          tally.aborted = true
          hooks.report({ kind: "aborted", failures: consecutiveFailures })
          break
        }
      }

      if (at.position < total) await hooks.wait()
    }

    return tally
  }
}
