import neo4j from "neo4j-driver"
import { config } from "@config"
import type { ISource, SearchResult, PathNodeInfo, PathSegment } from "@sources/ISource.js"
import { RELATIONSHIP_TYPES } from "@scrapers/nosisRelationshipTypes.js"

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
    async findPath(fromTaxId: string, toTaxId: string, maxDepth = 3): Promise<PathSegment[] | null> {
        const session = this.driver.session()

        try {
            const pathResult = await session.run(
                `
      MATCH path = shortestPath(
        (a:CUIT {id: $fromTaxId})-[:RELATED_TO*1..${maxDepth}]-(b:CUIT {id: $toTaxId})
      )
      RETURN [node in nodes(path) | node] as pathNodes
      `,
                { fromTaxId, toTaxId }
            )

            if (pathResult.records.length === 0) return null

            const pathNodes = pathResult.records[0]?.get("pathNodes") as { properties: Record<string, unknown> }[]
            const segments: PathSegment[] = []

            for (let i = 0; i < pathNodes.length - 1; i++) {
                const fromNode = pathNodes[i]!.properties
                const toNode = pathNodes[i + 1]!.properties

                const relsResult = await session.run(
                    `
        MATCH (a:CUIT {id: $fromId})-[r:RELATED_TO]-(b:CUIT {id: $toId})
        RETURN r.type as type
        `,
                    {
                        fromId: String(fromNode["id"] ?? ""),
                        toId: String(toNode["id"] ?? ""),
                    }
                )

                const relationships = relsResult.records.map(r => String(r.get("type") ?? ""))

                segments.push({
                    from: {
                        taxId: String(fromNode["id"] ?? ""),
                        businessName: String(fromNode["businessName"] ?? ""),
                        inMyBase: Boolean(fromNode["inMyBase"] ?? false),
                    },
                    to: {
                        taxId: String(toNode["id"] ?? ""),
                        businessName: String(toNode["businessName"] ?? ""),
                        inMyBase: Boolean(toNode["inMyBase"] ?? false),
                    },
                    relationships,
                })
            }

            return segments
        } finally {
            await session.close()
        }
    }

    /**
 * Returns the human-readable name for a valid relationship type code.
 * Returns null if the code is not valid.
 */
    getRelationshipTypeName(code: number): string | null {
        return RELATIONSHIP_TYPES[code] ?? null
    }

    /**
     * Returns all valid relationship type codes
     */
    validRelationshipCodes(): number[] {
        return Object.keys(RELATIONSHIP_TYPES).map(Number)
    }

    /**
     * Adds a relationship between two existing Tax IDs
     * @returns "created" | "not_found" | "duplicate"
     */
    async addRelationship(
        fromTaxId: string,
        toTaxId: string,
        relationshipType: string
    ): Promise<"created" | "not_found" | "duplicate"> {
        const session = this.driver.session()

        try {
            // Check both nodes exist
            const nodesResult = await session.run(
                `
      MATCH (a:CUIT {id: $fromTaxId})
      MATCH (b:CUIT {id: $toTaxId})
      RETURN a, b
      `,
                { fromTaxId, toTaxId }
            )

            if (nodesResult.records.length === 0) return "not_found"

            // Check if relationship already exists
            const existingResult = await session.run(
                `
      MATCH (a:CUIT {id: $fromTaxId})-[r:RELATED_TO {type: $relationshipType}]->(b:CUIT {id: $toTaxId})
      RETURN r
      `,
                { fromTaxId, toTaxId, relationshipType }
            )

            if (existingResult.records.length > 0) return "duplicate"

            // Create relationship
            await session.run(
                `
      MATCH (a:CUIT {id: $fromTaxId})
      MATCH (b:CUIT {id: $toTaxId})
      CREATE (a)-[:RELATED_TO {type: $relationshipType, source: "manual", createdAt: datetime()}]->(b)
      `,
                { fromTaxId, toTaxId, relationshipType }
            )

            return "created"
        } finally {
            await session.close()
        }
    }

    /**
 * Deletes a relationship between two Tax IDs
 * @returns "deleted" | "not_found"
 */
    async deleteRelationship(
        fromTaxId: string,
        toTaxId: string,
        relationshipType: string
    ): Promise<"deleted" | "not_found"> {
        const session = this.driver.session()

        try {
            const result = await session.run(
                `
      MATCH (a:CUIT {id: $fromTaxId})-[r:RELATED_TO {type: $relationshipType}]->(b:CUIT {id: $toTaxId})
      DELETE r
      RETURN count(r) as deleted
      `,
                { fromTaxId, toTaxId, relationshipType }
            )

            const deleted = result.records[0]?.get("deleted").toNumber() ?? 0
            return deleted > 0 ? "deleted" : "not_found"
        } finally {
            await session.close()
        }
    }

    /**
 * Gets a node by Tax ID
 */
    async getNode(taxId: string): Promise<Record<string, unknown> | null> {
        const session = this.driver.session()
        try {
            const result = await session.run(
                `MATCH (c:CUIT {id: $taxId}) RETURN c`,
                { taxId }
            )
            if (result.records.length === 0) return null
            const props = result.records[0]?.get("c").properties
            return {
                taxId: props.id,
                businessName: props.businessName ?? null,
                phone: props.phone ?? null,
                email: props.email ?? null,
                birthday: props.birthday ?? null,
                inMyBase: props.inMyBase ?? false,
                source: props.source ?? null,
            }
        } finally {
            await session.close()
        }
    }

    /**
     * Updates editable fields of a node
     * @returns "updated" | "not_found"
     */
    async updateNode(
        taxId: string,
        fields: { phone?: string | undefined; email?: string | undefined; birthday?: string | undefined }
    ): Promise<"updated" | "not_found"> {
        const session = this.driver.session()
        try {
            const result = await session.run(
                `
      MATCH (c:CUIT {id: $taxId})
      SET c.phone = $phone,
          c.email = $email,
          c.birthday = $birthday
      RETURN c
      `,
                {
                    taxId,
                    phone: fields.phone ?? null,
                    email: fields.email ?? null,
                    birthday: fields.birthday ?? null,
                }
            )
            return result.records.length > 0 ? "updated" : "not_found"
        } finally {
            await session.close()
        }
    }

    /**
 * Gets all relationships of a node up to a given depth
 * @param taxId - Tax ID to get relationships for
 * @param maxDepth - Maximum depth to traverse
 */
    async getAllRelationships(taxId: string, maxDepth = 3): Promise<SearchResult[] | null> {
        const session = this.driver.session()

        try {
            const nodeResult = await session.run(
                `MATCH (c:CUIT {id: $taxId}) RETURN c`,
                { taxId }
            )

            if (nodeResult.records.length === 0) return null

            const result = await session.run(
                `
      MATCH path = (c:CUIT {id: $taxId})-[:RELATED_TO*1..${maxDepth}]-(connected:CUIT)
      RETURN path
      `,
                { taxId }
            )

            return result.records.map((record) => {
                const path = record.get("path")
                const segments = path.segments as {
                    start: { properties: Record<string, unknown> }
                    relationship: { properties: Record<string, unknown> }
                    end: { properties: Record<string, unknown> }
                }[]

                const nodes = segments.map((s) => ({
                    taxId: String(s.start.properties["id"] ?? ""),
                    businessName: String(s.start.properties["businessName"] ?? ""),
                    relationshipType: String(s.relationship.properties["type"] ?? ""),
                    inMyBase: Boolean(s.start.properties["inMyBase"] ?? false),
                }))

                // Add last node
                const lastSegment = segments[segments.length - 1]
                if (lastSegment) {
                    nodes.push({
                        taxId: String(lastSegment.end.properties["id"] ?? ""),
                        businessName: String(lastSegment.end.properties["businessName"] ?? ""),
                        relationshipType: "",
                        inMyBase: Boolean(lastSegment.end.properties["inMyBase"] ?? false),
                    })
                }

                return {
                    cuit: String(path.start.properties["id"] ?? ""),
                    source: this.name,
                    file: "neo4j",
                    data: {
                        businessName: String(path.start.properties["businessName"] ?? ""),
                        inMyBase: Boolean(path.start.properties["inMyBase"] ?? false),
                        pathToBase: nodes,
                    },
                }
            })
        } finally {
            await session.close()
        }
    }

    /**
 * Returns all nodes with inMyBase = true and their depth-1 relationship count
 */
    async getMyBaseNodes(): Promise<{
        taxId: string
        businessName: string
        source: string
        relationshipCount: number
    }[]> {
        const session = this.driver.session()

        try {
            const result = await session.run(
                `
      MATCH (c:CUIT {inMyBase: true})
      OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT)
      RETURN c.id as taxId,
             c.businessName as businessName,
             c.source as source,
             count(DISTINCT related) as relationshipCount
      ORDER BY c.businessName
      `
            )

            return result.records.map((record) => ({
                taxId: String(record.get("taxId") ?? ""),
                businessName: String(record.get("businessName") ?? ""),
                source: String(record.get("source") ?? ""),
                relationshipCount: Number(record.get("relationshipCount") ?? 0),
            }))
        } finally {
            await session.close()
        }
    }
}