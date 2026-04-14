import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import type { GraphData } from "@scrapers/nosisMapper.js"

/**
 * Inserts a mapped Nosis graph into Neo4j.
 *
 * Uses the shared driver singleton and MERGE queries to avoid duplicates
 * on repeated runs. All nodes are inserted before relationships to
 * satisfy the MATCH preconditions in the relationship query.
 *
 * @param data - Mapped graph data from {@link mapToGraph}
 */
export async function insertGraphData(data: GraphData): Promise<void> {
  const session = Neo4jDriver.instance.session()

  try {
    for (const node of data.nodes) {
      await session.run(Queries.MERGE_NODE, {
        taxId: node.taxId,
        businessName: node.businessName,
      })
    }

    for (const rel of data.relationships) {
      await session.run(Queries.MERGE_RELATIONSHIP, {
        fromTaxId: rel.fromTaxId,
        toTaxId: rel.toTaxId,
        relationshipType: rel.relationshipType,
      })
    }
  } finally {
    await session.close()
  }
}