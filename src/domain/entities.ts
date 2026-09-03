/**
 * Core domain entities. These are pure data structures with no framework
 * dependencies — the heart of the hexagonal architecture.
 */

// ─── Node ────────────────────────────────────────────────────────────────────

/**
 * A CUIT node as stored in the graph database.
 *
 * Classification fields:
 *   - `isKnown`   → "conocidos" group (traditional sources, enriched via
 *                   Nosis, has relationships)
 *   - `isToKnow`  → "por conocer" group (lighter-weight, loaded without
 *                   Nosis enrichment, may carry loader-specific custom fields)
 *   - `inMyBase`  → derived: isKnown OR isToKnow
 *
 * `customFields` holds loader-specific attributes that aren't standardised
 * across the system (e.g. "publicationDate" for Empresas Concursadas). Common
 * fields like phone/email/birthday remain explicit because list views,
 * searches, and the birthday endpoint depend on knowing their names.
 */
export interface CuitNode {
  taxId: string
  businessName: string | null
  phone: string | null
  email: string | null
  birthday: string | null
  entryDate: string | null
  exitDate: string | null
  loadedAt: string | null
  isKnown: boolean
  isToKnow: boolean
  inMyBase: boolean
  sources: string[]
  /**
   * Loader-specific extra fields, e.g. `{ publicationDate: "12/03/2024" }`.
   * Keys come from each loader's own contract — there is no global enum.
   */
  customFields: Record<string, unknown>
}

export interface CuitNodeUpdate {
  phone?: string
  email?: string
  birthday?: string
}

export interface CuitNodeSummary {
  taxId: string
  businessName: string
  sources: string[]
  relationshipCount: number
  isKnown: boolean
  isToKnow: boolean
  /**
   * Sources of inMyBase nodes that this node is directly related to.
   * Only populated by `findCompanyNodes` — empty array otherwise.
   */
  relatedSources: string[]
}

/**
 * A node in the crossing-over view: it belongs to every requested source,
 * counting the ones it only reaches through a directly related node.
 */
export interface CrossingNode extends CuitNodeSummary {
  /**
   * The requested sources this node does NOT carry itself, and therefore
   * belongs to only through a neighbour. Empty for a plain member of all of
   * them, which is what the view returned before companies-by-relation
   * existed.
   */
  indirectSources: string[]
}

/**
 * A node matched by a free-text search over its business name.
 *
 * Covers the whole graph, not just the base: the point of searching by name is
 * to find a company whose CUIT you don't know, and those are frequently nodes
 * discovered through enrichment rather than loaded from a source. `inMyBase`
 * lets the caller tell the two apart.
 */
export interface NameSearchResult {
  taxId: string
  businessName: string
  sources: string[]
  inMyBase: boolean
  relationshipCount: number
}

export interface BirthdayResult {
  taxId: string
  businessName: string
  /** Stored as dd/mm/yyyy. */
  birthday: string
  sources: string[]
  relationshipCount: number
}

// ─── Path ────────────────────────────────────────────────────────────────────

export interface PathNodeInfo {
  taxId: string
  businessName: string
  inMyBase: boolean
}

export interface PathSegment {
  from: PathNodeInfo
  to: PathNodeInfo
  relationships: string[]
}

export interface PathHop {
  taxId: string
  businessName: string
  relationshipType: string
  inMyBase: boolean
}

// ─── Search result ───────────────────────────────────────────────────────────

export interface SearchResult {
  cuit: string
  source: string
  file: string
  data: {
    businessName?: string
    inMyBase?: boolean
    pathToBase?: PathHop[]
    [key: string]: unknown
  }
}

// ─── Relationship results ─────────────────────────────────────────────────────

export type AddRelationshipResult = "created" | "not_found" | "duplicate"
export type DeleteRelationshipResult = "deleted" | "not_found"
export type UpdateNodeResult = "updated" | "not_found"

// ═══════════════════════════════════════════════════════════════════════════
//  Loading domain
// ═══════════════════════════════════════════════════════════════════════════

export interface GraphRelationship {
  fromTaxId: string
  toTaxId: string
  relationshipType: string
}

export type LoadableNodeCategory = "known" | "to_know"

/**
 * A source registered in the graph as a first-class entity.
 * Sources are shared across many CuitNodes via the [:HAS_SOURCE]
 * relationship. The array `CuitNode.sources` is kept in sync as a
 * denormalised cache of the source names, but the Source node is
 * the source of truth for category and any future metadata.
 */
export interface SourceInfo {
  name: string
  category: LoadableNodeCategory
  nodeCount: number
}

/**
 * Administrative operations that can be performed over sources.
 */
export type SourceAdminOperation =
  | "rename"
  | "merge"
  | "delete"
  | "add-source"
  | "move-source"

/**
 * Standardised summary returned by every source admin operation.
 * Callers use this to display feedback and to log the effect.
 *
 * `affectedNodeCount` is the count measured BEFORE executing, so a dry
 * run and its real counterpart report the same figure.
 */
export interface OperationSummary {
  operation: SourceAdminOperation
  affectedNodeCount: number
  removedNodeCount: number
  updatedNodeCount: number
  createdSourceName?: string
  removedSourceName?: string
  dryRun: boolean
  message: string
}

/**
 * Reason a source admin operation was rejected before execution.
 * Handlers map these to HTTP status codes:
 *   - "source_not_found"     → 404
 *   - "name_conflict"        → 409
 *   - "category_mismatch"    → 409
 *   - "node_not_found"       → 404
 *   - "invalid_move_params"  → 400
 */
export type SourceAdminRejection =
  | "source_not_found"
  | "name_conflict"
  | "category_mismatch"
  | "node_not_found"
  | "invalid_move_params"

export interface LoadableNode {
  document: string
  businessName: string
  source: string
  attributes: LoadableNodeAttributes
  requiresRole?: string
  category?: LoadableNodeCategory
}

/**
 * Free-form attributes a loader can populate on a node.
 *
 * The standardised fields (phone, email, birthday, entryDate, exitDate,
 * loadedAt) cover what list views and search endpoints need to query by
 * name. Everything else goes into `customFields`, which Cypher merges
 * verbatim onto the node with `SET c += $customFields`.
 */
export interface LoadableNodeAttributes {
  phone?: string
  email?: string
  birthday?: string
  entryDate?: string
  exitDate?: string
  loadedAt?: string
  /**
   * Loader-specific custom fields persisted as-is on the Neo4j node.
   * Keys must be valid Cypher property names (alphanumeric + underscore,
   * starting with a letter). Values should be primitives or simple arrays;
   * objects nested inside aren't supported by Neo4j's property model.
   */
  customFields?: Record<string, unknown>
}

export interface LoadableRelationship {
  fromKey: string
  toKey: string
  relationshipType: string
}

export interface LoadableRow {
  rowId: string
  nodes: Record<string, LoadableNode>
  relationships: LoadableRelationship[]
  raw: Record<string, unknown>
}

export type NodeLoadStatus =
  | "loaded"
  | "not_found"
  | "skipped"
  | "skipped_due_to_dependency"
  | "failed"

export interface NodeLoadOutcome {
  roleKey: string
  status: NodeLoadStatus
  resolvedTaxId?: string
  notes?: string
}

export interface RowLoadOutcome {
  rowId: string
  row: LoadableRow
  nodes: NodeLoadOutcome[]
  overall: "all_loaded" | "partial" | "none"
}