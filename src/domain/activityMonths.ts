/**
 * Derives the months a node appeared in, from the operations a loader stored
 * on it.
 *
 * Loaders that carry per-period operations (currently "Deudores por
 * financiera") serialise them as a JSON string under `customFields.operations`,
 * each with a `date` anchored to the first of its period — "01/05/2026" means
 * the May 2026 file. Reading which months a debtor shows up in therefore means
 * parsing that list, and this is where that happens.
 */

/** One operation as persisted by the loaders. Only `date` is needed here. */
interface StoredOperation {
  date?: unknown
}

/** Matches the dd/mm/yyyy the loaders write. */
const DATE_PATTERN = /^\d{1,2}\/(\d{2})\/(\d{4})$/

/**
 * Distinct months found in a node's operations, as `yyyy-mm`, most recent
 * first.
 *
 * Returns an empty array for anything unusable — a node from another source,
 * a malformed payload, or operations whose period cell was blank in the
 * source file. Callers cannot distinguish "no operations" from "operations
 * without dates", and deliberately so: neither is worth showing.
 *
 * @param customFields - The node's loader-specific fields, as stored.
 */
export function extractActivityMonths(customFields: Record<string, unknown>): string[] {
  const raw = customFields["operations"]
  if (typeof raw !== "string" || raw.length === 0) return []

  let operations: unknown
  try {
    operations = JSON.parse(raw)
  } catch {
    /** A single corrupt node must not break the whole node lookup. */
    return []
  }
  if (!Array.isArray(operations)) return []

  const months = new Set<string>()
  for (const operation of operations as StoredOperation[]) {
    if (typeof operation?.date !== "string") continue
    const match = DATE_PATTERN.exec(operation.date)
    if (!match) continue
    months.add(`${match[2]}-${match[1]}`)
  }

  return [...months].sort().reverse()
}
