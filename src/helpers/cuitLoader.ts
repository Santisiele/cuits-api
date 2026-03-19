import type { Session } from "neo4j-driver"

const CUIT_REGEX = /^\d{2}-\d{8}-\d{1}$/

export interface CuitRecord {
  id: string
  name: string
  email: string
  phone: string
  source: string
}

/**
 * Filters valid CUITs from raw CSV records
 */
export function filterValidCuits(
  records: Record<string, string>[],
  source: string
): CuitRecord[] {
  return records
    .filter((row) => CUIT_REGEX.test(row["CUIT"] ?? ""))
    .map((row) => ({
      id: row["CUIT"] ?? "",
      name: row["Nombre completo"] ?? "",
      email: row["E-mail"] ?? "",
      phone: row["Telefono"] ?? "",
      source,
    }))
}

/**
 * Loads a list of CUITs into Neo4j using the provided session
 */
export async function loadCuitsIntoNeo4j(
  cuits: CuitRecord[],
  session: Session
): Promise<void> {
  for (const cuit of cuits) {
    await session.run(
      `
      MERGE (c:CUIT {id: $id})
      SET c.name = $name,
          c.email = $email,
          c.phone = $phone,
          c.inMyBase = true,
          c.source = $source
      `,
      cuit
    )
  }
}