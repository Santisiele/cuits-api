export const DEFAULT_MAX_DEPTH = 3
export const MAX_ALLOWED_DEPTH = 10

/**
 * Validates and parses a `maxDepth` query parameter string.
 *
 * @param value - Raw string value from the query string (may be undefined)
 * @returns Parsed depth, or `null` if the value is out of range / not a number
 */
export function parseMaxDepth(value?: string): number | null {
  if (!value) return DEFAULT_MAX_DEPTH
  const parsed = Number(value)
  if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ALLOWED_DEPTH) return null
  return parsed
}

export function rangeEndsBeforeItStarts(from: string, to: string): boolean {
  const start = toUtcTimestamp(from)
  const end = toUtcTimestamp(to)
  if (start === null || end === null) return false
  return end < start
}

function toUtcTimestamp(raw: string): number | null {
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw.trim())
  if (!match) return null
  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])
  if (day < 1 || day > 31 || month < 1 || month > 12) return null
  return Date.UTC(year, month - 1, day)
}
