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
  GraphRelationship,
  LoadableNodeAttributes,
  LoadableNodeCategory,
  BirthdayResult,
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
 *  - Execute Cypher queries via the shared driver singleton
 *  - Map raw Neo4j records to domain entities
 *  - Handle session lifecycle (always close in finally blocks)
 *
 * Classification handling:
 *  - `upsertBaseNode` takes a `category` ("known" | "to_know") and translates
 *    it into the `isKnown`/`isToKnow` flags passed to MERGE_BASE_NODE.
 *  - The Cypher query uses additive logic: a flag is only flipped TRUE if
 *    explicitly requested, so existing flags are preserved.
 */
export class Neo4jRepository implements IGraphRepository {
  private session(): Session {
    return Neo4jDriver.instance.session()
  }

  // ─── Node ─────────────────────────────────────────────────────────────────

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

  async findMyBaseNodes(): Promise<CuitNodeSummary[]> {
    const session = this.session()
    try {
      const result = await session.run(Queries.FIND_MY_BASE_NODES)
      return result.records.map((record) => ({
        taxId: String(record.get("taxId") ?? ""),
        businessName: String(record.get("businessName") ?? ""),
        sources: this.normalizeSources(record.get("sources")),
        relationshipCount: Number(record.get("relationshipCount") ?? 0),
        isKnown: Boolean(record.get("isKnown") ?? false),
        isToKnow: Boolean(record.get("isToKnow") ?? false),
        relatedSources: [],
      }))
    } finally {
      await session.close()
    }
  }

  async findToKnowNodes(): Promise<CuitNodeSummary[]> {
    const session = this.session()
    try {
      const result = await session.run(Queries.FIND_TO_KNOW_NODES)
      return result.records.map((record) => ({
        taxId: String(record.get("taxId") ?? ""),
        businessName: String(record.get("businessName") ?? ""),
        sources: this.normalizeSources(record.get("sources")),
        relationshipCount: Number(record.get("relationshipCount") ?? 0),
        isKnown: Boolean(record.get("isKnown") ?? false),
        isToKnow: Boolean(record.get("isToKnow") ?? false),
        relatedSources: [],
      }))
    } finally {
      await session.close()
    }
  }

  async findAllMyNodes(): Promise<CuitNodeSummary[]> {
    const session = this.session()
    try {
      const result = await session.run(Queries.FIND_ALL_MY_NODES)
      return result.records.map((record) => ({
        taxId: String(record.get("taxId") ?? ""),
        businessName: String(record.get("businessName") ?? ""),
        sources: this.normalizeSources(record.get("sources")),
        relationshipCount: Number(record.get("relationshipCount") ?? 0),
        isKnown: Boolean(record.get("isKnown") ?? false),
        isToKnow: Boolean(record.get("isToKnow") ?? false),
        relatedSources: [],
      }))
    } finally {
      await session.close()
    }
  }

  // ─── Birthdays ────────────────────────────────────────────────────────────

  async findBirthdaysBetween(
    fromMonth: number,
    fromDay: number,
    toMonth: number,
    toDay: number
  ): Promise<BirthdayResult[]> {
    const session = this.session()
    try {
      const result = await session.run(Queries.FIND_BIRTHDAY_CANDIDATES)
      const candidates: BirthdayResult[] = result.records.map((record) => ({
        taxId: String(record.get("taxId") ?? ""),
        businessName: String(record.get("businessName") ?? ""),
        birthday: String(record.get("birthday") ?? ""),
        sources: this.normalizeSources(record.get("sources")),
        relationshipCount: Number(record.get("relationshipCount") ?? 0),
      }))

      const inRange = (m: number, d: number): boolean => {
        const from = fromMonth * 100 + fromDay
        const to = toMonth * 100 + toDay
        const cur = m * 100 + d
        if (from <= to) return cur >= from && cur <= to
        return cur >= from || cur <= to
      }

      return candidates
        .filter((c) => {
          const parsed = this.parseDayMonth(c.birthday)
          if (!parsed) return false
          return inRange(parsed.month, parsed.day)
        })
        .sort((a, b) => {
          const pa = this.parseDayMonth(a.birthday)!
          const pb = this.parseDayMonth(b.birthday)!
          return (pa.month * 100 + pa.day) - (pb.month * 100 + pb.day)
        })
    } finally {
      await session.close()
    }
  }

  // ─── Ingestion ────────────────────────────────────────────────────────────

  /**
   * Upserts a base-group node, additively setting the classification flag
   * implied by `category`. Existing values are preserved — a node already
   * marked isKnown won't lose that flag if re-loaded as to_know, and vice
   * versa. A node loaded for the first time gets exactly one flag set.
   */
  async upsertBaseNode(
    taxId: string,
    businessName: string,
    source: string,
    attributes: LoadableNodeAttributes,
    category: LoadableNodeCategory = "known"
  ): Promise<void> {
    const session = this.session()
    try {
      await session.run(Queries.MERGE_BASE_NODE, {
        id: taxId,
        name: businessName,
        source,
        isKnown: category === "known",
        isToKnow: category === "to_know",
        phone: attributes.phone ?? null,
        email: attributes.email ?? null,
        birthday: attributes.birthday ?? null,
        entryDate: attributes.entryDate ?? null,
        exitDate: attributes.exitDate ?? null,
        loadedAt: attributes.loadedAt ?? null,
        customFields: attributes.customFields ?? {},
      })
    } finally {
      await session.close()
    }
  }

  async upsertEnrichmentNode(taxId: string, businessName: string): Promise<void> {
    const session = this.session()
    try {
      await session.run(Queries.MERGE_ENRICHMENT_NODE, { taxId, businessName })
    } finally {
      await session.close()
    }
  }

  async mergeRelationship(rel: GraphRelationship): Promise<void> {
    const session = this.session()
    try {
      await session.run(Queries.MERGE_RELATIONSHIP, {
        fromTaxId: rel.fromTaxId,
        toTaxId: rel.toTaxId,
        relationshipType: rel.relationshipType,
      })
    } finally {
      await session.close()
    }
  }

  // ─── Path ──────────────────────────────────────────────────────────────────

  async findPathsToBase(taxId: string, maxDepth: number): Promise<SearchResult[] | null> {
    const session = this.session()
    try {
      const nodeResult = await session.run(Queries.FIND_NODE, { taxId })
      if (nodeResult.records.length === 0) return null

      const node = nodeResult.records[0]!.get("c").properties

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

  async findCompanyNodes(): Promise<CuitNodeSummary[]> {
    const session = this.session()
    try {
      const result = await session.run(Queries.FIND_COMPANIES)
      return result.records.map((record) => ({
        taxId: String(record.get("taxId") ?? ""),
        businessName: String(record.get("businessName") ?? ""),
        sources: this.normalizeSources(record.get("sources")),
        relationshipCount: Number(record.get("relationshipCount") ?? 0),
        isKnown: Boolean(record.get("isKnown") ?? false),
        isToKnow: Boolean(record.get("isToKnow") ?? false),
        relatedSources: this.normalizeSources(record.get("relatedSources")),
      }))
    } finally {
      await session.close()
    }
  }

  // ─── Relationship types ────────────────────────────────────────────────────

  getRelationshipTypeName(code: number): string | null {
    return RELATIONSHIP_TYPES[code] ?? null
  }

  validRelationshipCodes(): number[] {
    return Object.keys(RELATIONSHIP_TYPES).map(Number)
  }

  // ─── Mapping helpers ───────────────────────────────────────────────────────

  private parseDayMonth(birthday: string): { day: number; month: number } | null {
    const match = /^(\d{1,2})[/-](\d{1,2})[/-]\d{2,4}$/.exec(birthday.trim())
    if (!match) return null
    const day = Number(match[1])
    const month = Number(match[2])
    if (!Number.isFinite(day) || !Number.isFinite(month)) return null
    if (day < 1 || day > 31 || month < 1 || month > 12) return null
    return { day, month }
  }

  private normalizeSources(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((s) => String(s)).filter(Boolean)
    if (typeof value === "string" && value.length > 0) return [value]
    return []
  }

  private mapNode(props: Record<string, unknown>): CuitNode {
    const isKnown = Boolean(props["isKnown"] ?? false)
    const isToKnow = Boolean(props["isToKnow"] ?? false)

    const KNOWN_KEYS = new Set([
      "id", "businessName", "phone", "email", "birthday",
      "entryDate", "exitDate", "loadedAt",
      "isKnown", "isToKnow", "inMyBase",
      "sources", "source",
    ])

    const customFields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(props)) {
      if (!KNOWN_KEYS.has(key) && value != null) {
        customFields[key] = value
      }
    }

    return {
      taxId: String(props["id"] ?? ""),
      businessName: props["businessName"] != null ? String(props["businessName"]) : null,
      phone: props["phone"] != null ? String(props["phone"]) : null,
      email: props["email"] != null ? String(props["email"]) : null,
      birthday: props["birthday"] != null ? String(props["birthday"]) : null,
      entryDate: props["entryDate"] != null ? String(props["entryDate"]) : null,
      exitDate: props["exitDate"] != null ? String(props["exitDate"]) : null,
      loadedAt: props["loadedAt"] != null ? String(props["loadedAt"]) : null,
      isKnown,
      isToKnow,
      inMyBase: isKnown || isToKnow,
      sources: this.normalizeSources(props["sources"] ?? props["source"]),
      customFields,
    }
  }

  private mapSegmentsToHops(segments: Neo4jSegment[]): PathHop[] {
    return segments.map((segment) => ({
      taxId: String(segment.end.properties["id"] ?? ""),
      businessName: String(segment.end.properties["businessName"] ?? ""),
      relationshipType: String(segment.relationship.properties["type"] ?? ""),
      inMyBase: Boolean(segment.end.properties["inMyBase"] ?? false),
    }))
  }
}