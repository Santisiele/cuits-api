import { DAILY_LIMIT, type ScrapeState } from "@helpers/birthdaySweep.js"

export const PROGRESS_TIME_ZONE = "America/Argentina/Buenos_Aires"

export interface BirthdaySweepSnapshot {
  day: string
  consultedToday: number
  dailyLimit: number
  misses: Record<string, string>
  updatedAt: string
}

export interface PeopleCount {
  knownPeople: number
  withBirthday: number
}

export interface SourceProgress {
  source: string
  people: number
  withBirthday: number
  missing: number
}

export interface PersonName {
  taxId: string
  businessName: string
}

export interface MissedPerson extends PersonName {
  missedOn: string
}

export interface PendingPerson extends PersonName {
  sources: string[]
}

export interface SweepStatus {
  day: string | null
  consultedToday: number
  dailyLimit: number
  updatedAt: string | null
}

export interface BirthdayProgress {
  knownPeople: number
  withBirthday: number
  missing: number
  bySource: SourceProgress[]
  sweep: SweepStatus
  misses: MissedPerson[]
  pending: PendingPerson[]
}

export interface ProgressParts {
  people: PeopleCount
  bySource: SourceProgress[]
  snapshot: BirthdaySweepSnapshot | null
  names: PersonName[]
  pending: PendingPerson[]
  today: string
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

export function dayIn(now: Date, timeZone: string = PROGRESS_TIME_ZONE): string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
  const parts = Object.fromEntries(format.formatToParts(now).map((part) => [part.type, part.value]))
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`
}

export function parseMisses(raw: unknown): Record<string, string> {
  if (typeof raw !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  } catch {
    return {}
  }
}

export function sweepStatus(snapshot: BirthdaySweepSnapshot | null, today: string): SweepStatus {
  if (!snapshot) return { day: null, consultedToday: 0, dailyLimit: DAILY_LIMIT, updatedAt: null }
  return {
    day: snapshot.day,
    consultedToday: snapshot.day === today ? snapshot.consultedToday : 0,
    dailyLimit: snapshot.dailyLimit,
    updatedAt: snapshot.updatedAt,
  }
}

export function missedPeople(misses: Record<string, string>, names: PersonName[]): MissedPerson[] {
  const nameOf = new Map(names.map((person) => [person.taxId, person.businessName]))
  return Object.entries(misses)
    .map(([taxId, missedOn]) => ({ taxId, businessName: nameOf.get(taxId) ?? "", missedOn }))
    .sort((a, b) => b.missedOn.localeCompare(a.missedOn) || a.businessName.localeCompare(b.businessName))
}

export function buildProgress(parts: ProgressParts): BirthdayProgress {
  return {
    knownPeople: parts.people.knownPeople,
    withBirthday: parts.people.withBirthday,
    missing: parts.people.knownPeople - parts.people.withBirthday,
    bySource: parts.bySource,
    sweep: sweepStatus(parts.snapshot, parts.today),
    misses: missedPeople(parts.snapshot?.misses ?? {}, parts.names),
    pending: parts.pending,
  }
}
