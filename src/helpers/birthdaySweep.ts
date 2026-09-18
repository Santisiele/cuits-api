export const DAILY_LIMIT = 100

export interface ScrapeState {
  day: string
  consultedToday: number
  misses: Record<string, string>
}

export function currentDay(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function emptyState(today: string): ScrapeState {
  return { day: today, consultedToday: 0, misses: {} }
}

export function restoreState(raw: string | null, today: string): ScrapeState {
  if (raw === null) return emptyState(today)

  const parsed = JSON.parse(raw) as Partial<ScrapeState>
  const misses = parsed.misses ?? {}

  if (parsed.day !== today) return { day: today, consultedToday: 0, misses }

  return {
    day: today,
    consultedToday: Math.max(0, Number(parsed.consultedToday) || 0),
    misses,
  }
}

export function budgetFor(
  requested: number,
  state: ScrapeState,
  dailyLimit: number = DAILY_LIMIT
): number {
  return Math.max(0, Math.min(requested, dailyLimit - state.consultedToday))
}

export function skipList(state: ScrapeState): string[] {
  return Object.keys(state.misses)
}

export function markConsultation(state: ScrapeState): ScrapeState {
  state.consultedToday++
  return state
}

export function markMiss(state: ScrapeState, taxId: string): ScrapeState {
  state.misses[taxId] = state.day
  return state
}
