export const DEFAULT_ACTIVITY_LIMIT = 200
export const MAX_ACTIVITY_LIMIT = 1000
export const MAX_LOG_BYTES = 20 * 1024 * 1024
export const KEPT_LOG_FILES = 3

export type ActivityLevel = "info" | "warn" | "error"

export interface ActivityEntry {
  time: string
  level: ActivityLevel
  event: string
  username: string | null
  details: Record<string, unknown>
}

export interface ActivityFilters {
  limit: number
  before: string | null
  seenAtBefore: number
  username: string | null
  event: string | null
}

const HIDDEN_FIELDS = new Set(["level", "time", "pid", "hostname", "event", "username", "message", "timestamp"])

function levelOf(value: unknown): ActivityLevel {
  if (typeof value !== "number") return "info"
  if (value >= 50) return "error"
  if (value >= 40) return "warn"
  return "info"
}

export function parseActivityLine(line: string): ActivityEntry | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record["time"] !== "number" || typeof record["event"] !== "string") return null
  const details = Object.fromEntries(Object.entries(record).filter(([key]) => !HIDDEN_FIELDS.has(key)))
  return {
    time: new Date(record["time"]).toISOString(),
    level: levelOf(record["level"]),
    event: record["event"],
    username: typeof record["username"] === "string" ? record["username"] : null,
    details,
  }
}

export function parseActivityFilters(query: {
  limit?: string
  before?: string
  seen?: string
  username?: string
  event?: string
}): ActivityFilters {
  const limit = Number(query.limit)
  const seen = Number(query.seen)
  const before = query.before && !Number.isNaN(Date.parse(query.before)) ? new Date(query.before).toISOString() : null
  return {
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_ACTIVITY_LIMIT) : DEFAULT_ACTIVITY_LIMIT,
    before,
    seenAtBefore: before !== null && Number.isInteger(seen) && seen > 0 ? seen : 0,
    username: query.username?.trim() ? query.username.trim().toLowerCase() : null,
    event: query.event?.trim() ? query.event.trim() : null,
  }
}

export function matchesActivity(entry: ActivityEntry, filters: ActivityFilters): boolean {
  if (filters.before !== null && entry.time > filters.before) return false
  if (filters.username !== null && entry.username?.toLowerCase() !== filters.username) return false
  if (filters.event !== null && entry.event !== filters.event) return false
  return true
}

export function rotatedLogNames(file: string, kept: number = KEPT_LOG_FILES): string[] {
  return Array.from({ length: kept }, (_, index) => `${file}.${index + 1}`)
}
