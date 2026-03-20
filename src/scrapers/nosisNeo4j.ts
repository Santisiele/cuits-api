import neo4j from "neo4j-driver"
import { config } from "@config"
import type { GraphData } from "@scrapers/nosisMapper.js"

/**
 * Inserts a mapped Nosis graph into Neo4j.
 * Uses MERGE to avoid duplicates on repeated runs.
 * @param data - Mapped graph data from nosisMapper
 */
export async function insertGraphData(data: GraphData): Promise<void> {
  const driver = neo4j.driver(
    config.neo4j.uri,
    neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
  )
  const session = driver.session()

  try {
    // Insert nodes
    for (const node of data.nodes) {
      await session.run(
        `
        MERGE (c:CUIT {id: $taxId})
        ON CREATE SET c.businessName = $businessName, c.inMyBase = false
        ON MATCH SET c.businessName = COALESCE(c.businessName, $businessName)
        `,
        { taxId: node.taxId, businessName: node.businessName }
      )
    }

    // Insert relationships
    for (const rel of data.relationships) {
      await session.run(
        `
        MATCH (a:CUIT {id: $fromTaxId})
        MATCH (b:CUIT {id: $toTaxId})
        MERGE (a)-[r:RELATED_TO {type: $relationshipType}]->(b)
        `,
        {
          fromTaxId: rel.fromTaxId,
          toTaxId: rel.toTaxId,
          relationshipType: rel.relationshipType,
        }
      )
    }
  } finally {
    await session.close()
    await driver.close()
  }
}