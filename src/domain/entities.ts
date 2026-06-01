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
  /** All sources that contributed this node (e.g. ["poseidon", "seniorHome"]). */
  sources: string[]
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
  /** All sources that contributed this node. */
  sources: string[]
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

// ─── Relationship results ─────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════════════
//  Loading domain
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A graph relationship to be persisted.
 * Same shape used by both enrichment and explicit user-defined links.
 */
export interface GraphRelationship {
  fromTaxId: string
  toTaxId: string
  relationshipType: string
}

/**
 * A node ready to be persisted by the loader pipeline.
 *
 * - `document` is what the loader has (DNI, CUIT, or other ID). The enricher
 *   resolves it to a real CUIT (`taxId`) which may differ when the input was
 *   a DNI.
 * - `attributes` are any source-specific extra fields the loader wants the
 *   node to carry (phone, email, dates, etc.). The repository decides which
 *   ones it persists.
 * - `source` is the tag appended to the node's `sources` array.
 */
export interface LoadableNode {
  /** Original document the loader had (DNI or CUIT, with or without separators). */
  document: string
  /** Display name (may be overridden by Nosis's RazonSocial if empty). */
  businessName: string
  /** Source tag for this node (e.g. "poseidon", "Residente Senior Home"). */
  source: string
  /** Source-specific attributes to persist on the node. */
  attributes: LoadableNodeAttributes
  /**
   * Optional role-key dependency: if set, this node is only processed when
   * the referenced role has already been loaded successfully in the same
   * row. Lets a loader express "load B only if A succeeded" without putting
   * source-specific policy in the LoaderService.
   *
   * Example (Senior Home): the `responsible` node sets `requiresRole: "resident"`,
   * so if the resident lookup fails the responsible is skipped entirely.
   */
  requiresRole?: string
}

/**
 * Optional per-node attributes that loaders can attach.
 * The repository persists whichever fields are present.
 */
export interface LoadableNodeAttributes {
  phone?: string
  email?: string
  entryDate?: string
  exitDate?: string
  loadedAt?: string
}

/**
 * A relationship between two LoadableNodes within the same input row.
 * Each end refers to a key the loader uses to identify its nodes within
 * the row (e.g. "resident" / "responsible"); the service resolves these
 * keys to actual CUITs after enrichment.
 */
export interface LoadableRelationship {
  fromKey: string
  toKey: string
  relationshipType: string
}

/**
 * A logical unit of work from a single input row.
 * One row may produce multiple nodes (e.g. resident + responsible) and
 * relationships between them.
 *
 * `nodes` is keyed so {@link LoadableRelationship} can reference them.
 */
export interface LoadableRow {
  /** Stable row identifier for logging and output (e.g. row number). */
  rowId: string
  /** Map of role → node. Keys are loader-defined ("resident", "main", etc.). */
  nodes: Record<string, LoadableNode>
  /** Inter-node relationships within this row, by role keys. */
  relationships: LoadableRelationship[]
  /** Free-form passthrough data the loader wants the writer to see. */
  raw: Record<string, unknown>
}

/**
 * Status of a single node within a row after running the loader pipeline.
 */
export type NodeLoadStatus = "loaded" | "not_found" | "skipped" | "skipped_due_to_dependency" | "failed"

/**
 * Per-node outcome — exposed to the writer so it can colour rows / log errors.
 */
export interface NodeLoadOutcome {
  /** Role key as defined in {@link LoadableRow.nodes}. */
  roleKey: string
  status: NodeLoadStatus
  /** Resolved CUIT (only present when status === "loaded"). */
  resolvedTaxId?: string
  /** Human-readable diagnostic. */
  notes?: string
}

/**
 * Outcome of processing one full row through the LoaderService.
 */
export interface RowLoadOutcome {
  rowId: string
  row: LoadableRow
  nodes: NodeLoadOutcome[]
  /** Aggregate status — convenience for writers that colour by row. */
  overall: "all_loaded" | "partial" | "none"
}