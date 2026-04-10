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