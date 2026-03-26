import neo4j from "neo4j-driver"
import { config } from "@config"
import type { ISource, SearchResult, PathNode } from "@sources/ISource.js"

/**
 * Data source adapter for Neo4j graph database.
 * Searches for a Tax ID and returns its info and paths to inMyBase nodes.
 */
export class Neo4jSource implements ISource {
    name = "neo4j"
    private driver

    constructor() {
        this.driver = neo4j.driver(
            config.neo4j.uri,
            neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
        )
    }

    /**
     * Searches for a Tax ID in Neo4j.
     * If inMyBase is true, returns node info.
     * If inMyBase is false, returns paths to inMyBase nodes.
     * @param taxId - Tax ID to search for
     * @param maxDepth - Maximum path depth (default: 3)
     */
    async search(cuit: string, maxDepth = 3): Promise<SearchResult[]> {
        const session = this.driver.session()

        try {
            const nodeResult = await session.run(
                `MATCH (c:CUIT {id: $taxId}) RETURN c`,
                { taxId: cuit }
            )

            if (nodeResult.records.length === 0) return []

            const node = nodeResult.records[0]?.get("c").properties

            if (node.inMyBase) {
                return [{
                    cuit,
                    source: this.name,
                    file: "neo4j",
                    data: {
                        businessName: node.businessName,
                        inMyBase: true,
                    },
                }]
            }

            const pathResult = await session.run(
                `
                MATCH path = (c:CUIT {id: $taxId})-[:RELATED_TO*1..${maxDepth}]-(target:CUIT {inMyBase: true})
                RETURN path
                LIMIT 10
                `,
                { taxId: cuit }
            )

            if (pathResult.records.length === 0) return []

            return pathResult.records.map((record) => {
                const path = record.get("path")
                const nodes = path.segments.map((s: {
                    start: { properties: Record<string, unknown> },
                    relationship: { properties: Record<string, unknown> }
                }) => ({
                    taxId: String(s.start.properties["id"] ?? ""),
                    businessName: String(s.start.properties["businessName"] ?? ""),
                    relationshipType: String(s.relationship.properties["type"] ?? ""),
                }))

                const lastSegment = path.segments[path.segments.length - 1]
                if (lastSegment) {
                    nodes.push({
                        taxId: String(lastSegment.end.properties["id"] ?? ""),
                        businessName: String(lastSegment.end.properties["businessName"] ?? ""),
                        relationshipType: "",
                    })
                }

                return {
                    cuit,
                    source: this.name,
                    file: "neo4j",
                    data: {
                        businessName: node.businessName,
                        inMyBase: false,
                        pathToBase: nodes,
                    },
                }
            })
        } finally {
            await session.close()
        }
    }

    /**
   * Finds the shortest path between two Tax IDs in the graph
   * @param fromTaxId - Starting Tax ID
   * @param toTaxId - Target Tax ID
   * @param maxDepth - Maximum path depth (default: 3)
   */
    async findPath(fromTaxId: string, toTaxId: string, maxDepth = 3): Promise<PathNode[] | null> {
        const session = this.driver.session()

        try {
            const result = await session.run(
                `
      MATCH path = shortestPath(
        (a:CUIT {id: $fromTaxId})-[:RELATED_TO*1..${maxDepth}]-(b:CUIT {id: $toTaxId})
      )
      RETURN path
      `,
                { fromTaxId, toTaxId }
            )

            if (result.records.length === 0) return null

            const path = result.records[0]?.get("path")
            return path.segments.map((s: { start: { properties: Record<string, unknown> }, relationship: { properties: Record<string, unknown> } }) => ({
                taxId: String(s.start.properties["id"] ?? ""),
                businessName: String(s.start.properties["businessName"] ?? ""),
                relationshipType: String(s.relationship.properties["type"] ?? ""),
            }))
        } finally {
            await session.close()
        }
    }
}