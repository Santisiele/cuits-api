import type { Session } from "neo4j-driver"
import { Queries } from "@infrastructure/neo4j/queries.js"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CuitRecord {
  taxId: string
  businessName: string
  source: string
}

// ─── Validation ───────────────────────────────────────────────────────────────

const CUIT_COLUMN = "CUIT"
const NAME_COLUMN = "Nombre completo"
const CUIT_REGEX = /^\d{2}-\d{8}-\d{1}$/

/**
 * Filters a list of raw CSV rows to only those with a valid CUIT.
 * Returns structured {@link CuitRecord} objects ready for insertion.
 *
 * @param rows - Raw rows from csv-parse
 * @param source - Source identifier to tag each record with
 */
export function filterValidCuits(
  rows: Record<string, string>[],
  source: string
): CuitRecord[] {
  return rows
    .filter((row) => CUIT_REGEX.test(String(row[CUIT_COLUMN] ?? "").trim()))
    .map((row) => ({
      taxId: String(row[CUIT_COLUMN]).trim().replace(/-/g, ""),
      businessName: String(row[NAME_COLUMN] ?? "").trim(),
      source,
    }))
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Inserts or updates a list of CUIT records into Neo4j.
 * Uses MERGE to avoid duplicates on repeated runs.
 *
 * @param records - Validated CUIT records to insert
 * @param session - An open Neo4j session (caller is responsible for closing)
 */
export async function loadCuitsIntoNeo4j(
  records: CuitRecord[],
  session: Session
): Promise<void> {
  for (const record of records) {
    await session.run(Queries.MERGE_BASE_NODE, {
      id: record.taxId,
      name: record.businessName,
      source: record.source,
    })
  }
}