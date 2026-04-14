import type { Session } from "neo4j-driver"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import { RELATIONSHIP_TYPES } from "@scrapers/nosisRelationshipTypes.js"
import type { IGraphRepository } from "@ports/interfaces.js"
import type {
  CuitNode,
  CuitNodeUpdate,
  CuitNodeSummary,
  PathSegment,
  PathHop,
  SearchResult,
  AddRelationshipResult,
  DeleteRelationshipResult,
  UpdateNodeResult,
} from "@domain/entities.js"

// ─── Internal Neo4j segment type ─────────────────────────────────────────────

interface Neo4jSegment {
  start: { properties: Record<string, unknown> }
  relationship: { properties: Record<string, unknown> }
  end: { properties: Record<string, unknown> }
}

// ─── Repository ───────────────────────────────────────────────────────────────

/**
 * Neo4j adapter implementing the {@link IGraphRepository} port.
 *
 * Responsibilities:
 * - Execute Cypher queries via the shared driver singleton
 * - Map raw Neo4j records to domain entities
 * - Handle session lifecycle (always close in finally blocks)
 *
 * This class contains NO business logic — only data access and mapping.
 */
export class Neo4jRepository implements IGraphRepository {
  /** Opens a new session from the shared driver singleton. */
  private session(): Session {
    return Neo4jDriver.instance.session()
  }

  // ─── Node ─────────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async findNode(taxId: string): Promise<CuitNode | null> {
    const session = this.session()
    try {
      const result = await session.run(Queries.FIND_NODE, { taxId })
      if (result.records.length === 0) return null
      return this.mapNode(result.records[0]!.get("c").properties)
    } finally {
      await session.close()
    }
  }

  /** @inheritdoc */
  async updateNode(taxId: string, fields: CuitNodeUpdate): Promise<UpdateNodeResult> {
    const session = this.session()
    try {
      const result = await session.run(Queries.UPDATE_NODE, {
        taxId,
        phone: "phone" in fields ? fields.phone : null,
        email: "email" in fields ? fields.email : null,
        birthday: "birthday" in fields ? fields.birthday : null,
      })
      return result.records.length > 0 ? "updated" : "not_found"
    } finally {
      await session.close()
    }
  }

  /** @inheritdoc */
  async findMyBaseNodes(): Promise<CuitNodeSummary[]> {
    const session = this.session()
    try {
      const result = await session.run(Queries.FIND_MY_BASE_NODES)
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

  // ─── Path ──────────────────────────────────────────────────────────────────

  /** @inheritdoc */
  async findPathsToBase(taxId: string, maxDepth: number): Promise<SearchResult[] | null> {
    const session = this.session()
    try {
      // First verify the node exists
      const nodeResult = await session.run(Queries.FIND_NODE, { taxId })
      if (nodeResult.records.length === 0) return null

      const node = nodeResult.records[0]!.get("c").properties

      // If the node itself is in our base, return it directly
      if (node.inMyBase) {
        return [{
          cuit: taxId,
          source: "neo4j",
          file: "neo4j",
          data: {
            businessName: String(node.businessName ?? ""),
            inMyBase: true,
          },
        }]
      }

      const pathResult = await session.run(
        Queries.FIND_PATHS_TO_BASE(maxDepth),
        { taxId }
      )

      if (pathResult.records.length === 0) return []

      return pathResult.records.map((record) => {
        const path = record.get("path")
        const segments = path.segments as Neo4jSegment[]
        const pathToBase = this.mapSegmentsToHops(segments)

        return {
          cuit: taxId,
          source: "neo4j",
          file: "neo4j",
          data: {
            businessName: String(node.businessName ?? ""),
            inMyBase: false,
            pathToBase,
          },
        }
      })
    } finally {
      await session.close()
    }
  }

  /** @inheritdoc */
  async findShortestPath(
    fromTaxId: string,
    toTaxId: string,
    maxDepth: number
  ): Promise<PathSegment[] | null> {
    const session = this.session()
    try {
      const pathResult = await session.run(
        Queries.FIND_SHORTEST_PATH(maxDepth),
        { fromTaxId, toTaxId }
      )

      if (pathResult.records.length === 0) return null

      const pathNodes = pathResult.records[0]!.get("pathNodes") as {
        properties: Record<string, unknown>
      }[]

      const segments: PathSegment[] = []

      for (let i = 0; i < pathNodes.length - 1; i++) {
        const fromNode = pathNodes[i]!.properties
        const toNode = pathNodes[i + 1]!.properties

        const relsResult = await session.run(Queries.FIND_RELATIONSHIPS_BETWEEN, {
          fromId: String(fromNode["id"] ?? ""),
          toId: String(toNode["id"] ?? ""),
        })

        const relationships = relsResult.records.map((r) => String(r.get("type") ?? ""))

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

  /** @inheritdoc */
  async findAllRelationships(taxId: string, maxDepth: number): Promise<SearchResult[] | null> {
    const session = this.session()
    try {
      const nodeResult = await session.run(Queries.FIND_NODE, { taxId })
      if (nodeResult.records.length === 0) return null

      const result = await session.run(
        Queries.FIND_ALL_RELATIONSHIPS(maxDepth),
        { taxId }
      )

      return result.records.map((record) => {
        const path = record.get("path")
        const segments = path.segments as Neo4jSegment[]
        const pathToBase = this.mapSegmentsToHops(segments)

        return {
          cuit: String(path.start.properties["id"] ?? ""),
          source: "neo4j",
          file: "neo4j",
          data: {
            businessName: String(path.start.properties["businessName"] ?? ""),
            inMyBase: Boolean(path.start.properties["inMyBase"] ?? false),
            pathToBase,
          },
        }
      })
    } finally {
      await session.close()
    }
  }

  // ─── Relationship ──────────────────────────────────────────────────────────

  /** @inheritdoc */
  async addRelationship(
    fromTaxId: string,
    toTaxId: string,
    relationshipType: string
  ): Promise<AddRelationshipResult> {
    const session = this.session()
    try {
      const nodesResult = await session.run(Queries.CHECK_NODES_EXIST, { fromTaxId, toTaxId })
      if (nodesResult.records.length === 0) return "not_found"

      const existingResult = await session.run(Queries.CHECK_RELATIONSHIP_EXISTS, {
        fromTaxId,
        toTaxId,
        relationshipType,
      })
      if (existingResult.records.length > 0) return "duplicate"

      await session.run(Queries.CREATE_RELATIONSHIP, { fromTaxId, toTaxId, relationshipType })
      return "created"
    } finally {
      await session.close()
    }
  }

  /** @inheritdoc */
  async deleteRelationship(
    fromTaxId: string,
    toTaxId: string,
    relationshipType: string
  ): Promise<DeleteRelationshipResult> {
    const session = this.session()
    try {
      const result = await session.run(Queries.DELETE_RELATIONSHIP, {
        fromTaxId,
        toTaxId,
        relationshipType,
      })
      const deleted = result.records[0]?.get("deleted").toNumber() ?? 0
      return deleted > 0 ? "deleted" : "not_found"
    } finally {
      await session.close()
    }
  }

  // ─── Relationship types ────────────────────────────────────────────────────

  /** @inheritdoc */
  getRelationshipTypeName(code: number): string | null {
    return RELATIONSHIP_TYPES[code] ?? null
  }

  /** @inheritdoc */
  validRelationshipCodes(): number[] {
    return Object.keys(RELATIONSHIP_TYPES).map(Number)
  }

  // ─── Mapping helpers ───────────────────────────────────────────────────────

  /**
   * Maps raw Neo4j node properties to the {@link CuitNode} domain entity.
   */
  private mapNode(props: Record<string, unknown>): CuitNode {
    return {
      taxId: String(props["id"] ?? ""),
      businessName: props["businessName"] != null ? String(props["businessName"]) : null,
      phone: props["phone"] != null ? String(props["phone"]) : null,
      email: props["email"] != null ? String(props["email"]) : null,
      birthday: props["birthday"] != null ? String(props["birthday"]) : null,
      inMyBase: Boolean(props["inMyBase"] ?? false),
      source: props["source"] != null ? String(props["source"]) : null,
    }
  }

  /**
   * Converts a list of Neo4j path segments into an ordered array of
   * {@link PathHop} objects.
   *
   * **Bug fix:** The previous implementation included the start node as
   * `path[0]` with no relationship type, and left the last node's
   * `relationshipType` empty. This method corrects both issues:
   *
   * - `path[0]` is the start node itself (skipped — already known to the caller)
   * - Each subsequent hop carries the relationship that leads TO it
   * - The last node's relationship is read from the last segment's relationship
   *
   * Resulting array: `[hop1, hop2, ..., hopN]` where `hop1.relationshipType`
   * is the type of the edge from the start node to hop1, and so on.
   */
  private mapSegmentsToHops(segments: Neo4jSegment[]): PathHop[] {
    return segments.map((segment) => ({
      taxId: String(segment.end.properties["id"] ?? ""),
      businessName: String(segment.end.properties["businessName"] ?? ""),
      relationshipType: String(segment.relationship.properties["type"] ?? ""),
      inMyBase: Boolean(segment.end.properties["inMyBase"] ?? false),
    }))
  }
}