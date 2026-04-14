/**
 * Core domain entities. These are pure data structures with no framework
 * dependencies — the heart of the hexagonal architecture.
 */

// ─── Node ────────────────────────────────────────────────────────────────────

/**
 * A CUIT node as stored in the graph database.
 */
export interface CuitNode {
  taxId: string
  businessName: string | null
  phone: string | null
  email: string | null
  birthday: string | null
  inMyBase: boolean
  source: string | null
}

/**
 * Fields that can be updated on a CuitNode.
 * All fields are optional — only provided fields are written.
 */
export interface CuitNodeUpdate {
  phone?: string
  email?: string
  birthday?: string
}

/**
 * A lightweight summary of a CuitNode used in list views.
 */
export interface CuitNodeSummary {
  taxId: string
  businessName: string
  source: string
  relationshipCount: number
}

// ─── Path ────────────────────────────────────────────────────────────────────

/**
 * A node reference within a path — carries only the fields
 * needed to render a graph segment.
 */
export interface PathNodeInfo {
  taxId: string
  businessName: string
  inMyBase: boolean
}

/**
 * A directed segment between two consecutive nodes in a path,
 * including every relationship type that connects them.
 */
export interface PathSegment {
  from: PathNodeInfo
  to: PathNodeInfo
  relationships: string[]
}

/**
 * A single hop in a pathToBase result.
 * Each hop represents one node along the path from the searched CUIT
 * to an inMyBase node, together with the relationship leading TO it.
 */
export interface PathHop {
  taxId: string
  businessName: string
  /** Relationship type leading FROM the previous node TO this one. */
  relationshipType: string
  inMyBase: boolean
}

// ─── Search result ───────────────────────────────────────────────────────────

/**
 * A single result returned by any data source for a CUIT search.
 */
export interface SearchResult {
  cuit: string
  source: string
  file: string
  data: {
    businessName?: string
    inMyBase?: boolean
    /** Ordered hops from the searched CUIT to an inMyBase node. */
    pathToBase?: PathHop[]
    [key: string]: unknown
  }
}

// ─── Relationship ─────────────────────────────────────────────────────────────

/**
 * Result of an addRelationship operation.
 */
export type AddRelationshipResult = "created" | "not_found" | "duplicate"

/**
 * Result of a deleteRelationship operation.
 */
export type DeleteRelationshipResult = "deleted" | "not_found"

/**
 * Result of an updateNode operation.
 */
export type UpdateNodeResult = "updated" | "not_found"