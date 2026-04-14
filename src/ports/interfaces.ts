import type {
  SearchResult,
  PathSegment,
  CuitNode,
  CuitNodeUpdate,
  CuitNodeSummary,
  AddRelationshipResult,
  DeleteRelationshipResult,
  UpdateNodeResult,
} from "@domain/entities.js"

// ─── Source port (inbound) ────────────────────────────────────────────────────

/**
 * Port that every data source adapter must implement.
 * This is the primary inbound port of the hexagonal architecture —
 * the application core depends on this abstraction, never on concrete adapters.
 */
export interface ISource {
  /** Unique identifier for this source (e.g. "neo4j", "csv-poseidon"). */
  readonly name: string

  /**
   * Searches for a CUIT across this source.
   * @param taxId - The CUIT to search for
   * @param maxDepth - Maximum graph traversal depth (graph sources only)
   */
  search(taxId: string, maxDepth?: number): Promise<SearchResult[]>
}

// ─── Graph repository port (outbound) ─────────────────────────────────────────

/**
 * Outbound port for graph database operations.
 * The application core uses this interface; Neo4j is one possible adapter.
 * New graph databases (e.g. ArangoDB, Amazon Neptune) only need to implement this.
 */
export interface IGraphRepository {
  /**
   * Finds a node by Tax ID. Returns null if not found.
   */
  findNode(taxId: string): Promise<CuitNode | null>

  /**
   * Finds all paths from a given Tax ID to inMyBase nodes.
   * Returns an empty array if the node exists but has no paths.
   * Returns null if the node does not exist.
   *
   * @param taxId - The CUIT to start from
   * @param maxDepth - Maximum hops to traverse
   */
  findPathsToBase(taxId: string, maxDepth: number): Promise<SearchResult[] | null>

  /**
   * Finds the shortest path between two Tax IDs.
   * Returns null if no path exists within maxDepth.
   */
  findShortestPath(fromTaxId: string, toTaxId: string, maxDepth: number): Promise<PathSegment[] | null>

  /**
   * Returns all nodes and relationships reachable from a given Tax ID.
   * Returns null if the node does not exist.
   */
  findAllRelationships(taxId: string, maxDepth: number): Promise<SearchResult[] | null>

  /**
   * Returns all nodes with inMyBase = true and their relationship counts.
   */
  findMyBaseNodes(): Promise<CuitNodeSummary[]>

  /**
   * Updates editable fields on a node.
   */
  updateNode(taxId: string, fields: CuitNodeUpdate): Promise<UpdateNodeResult>

  /**
   * Adds a directed relationship between two existing nodes.
   */
  addRelationship(fromTaxId: string, toTaxId: string, relationshipType: string): Promise<AddRelationshipResult>

  /**
   * Deletes a directed relationship between two nodes.
   */
  deleteRelationship(fromTaxId: string, toTaxId: string, relationshipType: string): Promise<DeleteRelationshipResult>

  /**
   * Returns the human-readable name for a relationship type code.
   * Returns null if the code is unknown.
   */
  getRelationshipTypeName(code: number): string | null

  /**
   * Returns all valid relationship type codes.
   */
  validRelationshipCodes(): number[]
}