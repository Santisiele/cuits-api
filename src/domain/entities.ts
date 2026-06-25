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
  /** Date the person joined (Senior Home and similar sources). */
  entryDate: string | null
  /** Date the person left (Senior Home and similar sources). */
  exitDate: string | null
  /** Date this node was loaded into the graph (dd/mm/yyyy). */
  loadedAt: string | null
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
  sources: string[]
  relationshipCount: number
}

/**
 * A node returned by a birthday query — carries only the fields needed
 * to render a birthday list.
 */
export interface BirthdayResult {
  taxId: string
  businessName: string
  /** Stored as dd/mm/yyyy. */
  birthday: string
  sources: string[]
  /** Number of distinct nodes connected by RELATED_TO. */
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

export interface LoadableNode {
  document: string
  businessName: string
  source: string
  attributes: LoadableNodeAttributes
  requiresRole?: string
}

export interface LoadableNodeAttributes {
  phone?: string
  email?: string
  birthday?: string
  entryDate?: string
  exitDate?: string
  loadedAt?: string
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

export type NodeLoadStatus = "loaded" | "not_found" | "skipped" | "skipped_due_to_dependency" | "failed"

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