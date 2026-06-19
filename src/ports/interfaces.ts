import type {
  SearchResult,
  PathSegment,
  CuitNode,
  CuitNodeUpdate,
  CuitNodeSummary,
  AddRelationshipResult,
  DeleteRelationshipResult,
  UpdateNodeResult,
  LoadableRow,
  LoadableNode,
  LoadableNodeAttributes,
  GraphRelationship,
  RowLoadOutcome,
} from "@domain/entities.js"

// ─── Source port (inbound, for search) ────────────────────────────────────────

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
  findNode(taxId: string): Promise<CuitNode | null>
  findPathsToBase(taxId: string, maxDepth: number): Promise<SearchResult[] | null>
  findShortestPath(fromTaxId: string, toTaxId: string, maxDepth: number): Promise<PathSegment[] | null>
  findAllRelationships(taxId: string, maxDepth: number): Promise<SearchResult[] | null>
  findMyBaseNodes(): Promise<CuitNodeSummary[]>
  updateNode(taxId: string, fields: CuitNodeUpdate): Promise<UpdateNodeResult>
  addRelationship(fromTaxId: string, toTaxId: string, relationshipType: string): Promise<AddRelationshipResult>
  deleteRelationship(fromTaxId: string, toTaxId: string, relationshipType: string): Promise<DeleteRelationshipResult>
  getRelationshipTypeName(code: number): string | null
  validRelationshipCodes(): number[]
  findCompanyNodes(): Promise<CuitNodeSummary[]>

  /**
   * Upserts a node as `inMyBase = true`, persisting the given attributes
   * and idempotently appending `source` to its `sources` array.
   *
   * Used by the LoaderService — the contract is "this source is authoritative
   * for these attributes on this run", meaning provided fields are written
   * unconditionally and omitted fields are left untouched.
   */
  upsertBaseNode(
    taxId: string,
    businessName: string,
    source: string,
    attributes: LoadableNodeAttributes
  ): Promise<void>

  /**
   * Upserts a plain node (not marked `inMyBase`), used for enrichment nodes
   * brought in by relationship trees. Existing `businessName` is preserved.
   */
  upsertEnrichmentNode(taxId: string, businessName: string): Promise<void>

  /**
   * Idempotently creates a typed directed relationship between two nodes.
   */
  mergeRelationship(rel: GraphRelationship): Promise<void>
}

// ─── Source loader port (outbound, for ingestion) ────────────────────────────

/**
 * Outbound port that knows how to read a specific source format and
 * yield rows ready to be processed by the LoaderService.
 *
 * Each concrete loader (PoseidonLoader, SeniorHomeLoader, etc.) encapsulates
 * its own parsing rules, column mappings, and per-row business logic.
 */
export interface ISourceLoader {
  /** Unique identifier for the source as a whole (e.g. "poseidon"). */
  readonly sourceName: string

  /**
   * Reads the input and returns the rows to be processed.
   *
   * @param opts.startRow - 1-based index of the first row to load (excluding header)
   * @param opts.count    - Maximum number of rows to load
   */
  load(opts: { startRow: number; count: number }): Promise<LoadableRow[]>
}

// ─── Enricher port (outbound, for resolving + scraping documents) ────────────

/**
 * Outbound port that resolves a document (DNI or CUIT) to a real CUIT
 * and fetches its relationship graph from an external system (e.g. Nosis).
 *
 * Implementations are responsible for rate-limiting and authentication.
 */
export interface IEnricher {
  /**
   * Resolves a document string to a real CUIT + business name.
   * Returns null if the document is not found in the external system.
   *
   * @param document - DNI (e.g. "12345678") or CUIT (e.g. "20123456789"),
   *                   with or without separators.
   */
  resolveDocument(document: string): Promise<EnrichmentIdentity | null>

  /**
   * Fetches the relationship tree for an already-resolved CUIT and returns
   * it as a flat list of nodes + relationships ready to persist.
   */
  fetchRelationshipGraph(taxId: string, businessName: string): Promise<EnrichmentGraph>
}

export interface EnrichmentIdentity {
  taxId: string
  businessName: string
}

export interface EnrichmentGraph {
  nodes: { taxId: string; businessName: string }[]
  relationships: GraphRelationship[]
}

// ─── Load output writer port (outbound, optional) ────────────────────────────

/**
 * Outbound port for writing the result of a load run.
 * Optional — sources that don't need an output report can skip it.
 *
 * Senior Home uses this to write its colour-coded Excel report.
 */
export interface ILoadOutputWriter {
  write(outcomes: RowLoadOutcome[]): Promise<void>
}

// ─── Helpers re-exported for adapter use ─────────────────────────────────────

export type { LoadableNode, LoadableNodeAttributes, GraphRelationship }