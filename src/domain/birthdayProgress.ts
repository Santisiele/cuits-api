import type { ScrapeState } from "@helpers/birthdaySweep.js"

export interface BirthdaySweepSnapshot {
  day: string
  consultedToday: number
  dailyLimit: number
  misses: Record<string, string>
  updatedAt: string
}

export function toSnapshot(state: ScrapeState, dailyLimit: number, updatedAt: string): BirthdaySweepSnapshot {
  return {
    day: state.day,
    consultedToday: state.consultedToday,
    dailyLimit,
    misses: { ...state.misses },
    updatedAt,
  }
}
