/**
 * Ports — abstract interfaces the application layer depends on.
 * Concrete adapters in `infrastructure/` implement these.
 *
 * Following hexagonal architecture: the application core knows nothing
 * about Neo4j, Nosis, or Excel files — only that someone, somewhere,
 * implements these contracts.
 */

import type {
  CuitNode,
  CuitNodeUpdate,
  CuitNodeSummary,
  PathSegment,
  SearchResult,
  AddRelationshipResult,
  DeleteRelationshipResult,
  UpdateNodeResult,
  GraphRelationship,
  LoadableRow,
  LoadableNodeAttributes,
  BirthdayResult,
  LoadableNodeCategory
} from "@domain/entities.js"

// ─── Driving ports (inbound) ──────────────────────────────────────────────────

/**
 * A backend that can search a CUIT and return zero or more results.
 * Different implementations cover different storage backends (Neo4j, CSV...).
 */
export interface ISource {
  search(taxId: string, maxDepth: number | undefined): Promise<SearchResult[]>
  /** Optional human-readable identifier for the source. */
  readonly name?: string
}

// ─── Driven ports (outbound) ──────────────────────────────────────────────────

/**
 * Abstract repository over the graph database.
 * The application layer uses ONLY this interface — never the Neo4j driver.
 */
export interface IGraphRepository {
  // Reads
  findNode(taxId: string): Promise<CuitNode | null>
  findMyBaseNodes(): Promise<CuitNodeSummary[]>
  findCompanyNodes(): Promise<CuitNodeSummary[]>
  findPathsToBase(taxId: string, maxDepth: number): Promise<SearchResult[] | null>
  findShortestPath(fromTaxId: string, toTaxId: string, maxDepth: number): Promise<PathSegment[] | null>
  findAllRelationships(taxId: string, maxDepth: number): Promise<SearchResult[] | null>
  findToKnowNodes(): Promise<CuitNodeSummary[]>
  findAllMyNodes(): Promise <CuitNodeSummary[]>

  /**
   * Returns every inMyBase node whose birthday falls on or between
   * (`fromMonth`/`fromDay`) and (`toMonth`/`toDay`), ignoring the year.
   * The year of `birthday` itself is preserved in the result so callers
   * can still display it.
   *
   * Year wrap is the repository's responsibility — when `from` is later in
   * the calendar than `to` (e.g. Dec 20 → Jan 5), it must include both ends
   * of the wrap.
   */
  findBirthdaysBetween(
    fromMonth: number,
    fromDay: number,
    toMonth: number,
    toDay: number
  ): Promise<BirthdayResult[]>

  // Writes
  updateNode(taxId: string, fields: CuitNodeUpdate): Promise<UpdateNodeResult>
  addRelationship(fromTaxId: string, toTaxId: string, relationshipType: string): Promise<AddRelationshipResult>
  deleteRelationship(fromTaxId: string, toTaxId: string, relationshipType: string): Promise<DeleteRelationshipResult>

  /**
   * Upserts a base-group node.
   * @param category - "known" (default) or "to_know". Additive: re-loading
   *                   an existing node never clears the other flag.
   */
  findBirthdaysBetween(
    fromMonth: number,
    fromDay: number,
    toMonth: number,
    toDay: number
  ): Promise<BirthdayResult[]>

  // Writes
  updateNode(taxId: string, fields: CuitNodeUpdate): Promise<UpdateNodeResult>
  addRelationship(fromTaxId: string, toTaxId: string, relationshipType: string): Promise<AddRelationshipResult>
  deleteRelationship(fromTaxId: string, toTaxId: string, relationshipType: string): Promise<DeleteRelationshipResult>

  // Ingestion (used by LoaderService)
  upsertBaseNode(
    taxId: string,
    businessName: string,
    source: string,
    attributes: LoadableNodeAttributes,
    category?: LoadableNodeCategory
  ): Promise<void>
  upsertEnrichmentNode(taxId: string, businessName: string): Promise<void>
  mergeRelationship(rel: GraphRelationship): Promise<void>

  // Misc
  getRelationshipTypeName(code: number): string | null
  validRelationshipCodes(): number[]
}

/**
 * Upstream enrichment provider that resolves a document into a CUIT and
 * fetches its relationship graph.
 */
export interface IEnricher {
  resolveDocument(document: string): Promise<{ taxId: string; businessName: string } | null>
  fetchRelationshipGraph(
    taxId: string,
    businessName: string
  ): Promise<{ nodes: { taxId: string; businessName: string }[]; relationships: GraphRelationship[] }>
}

/**
 * A loader that reads rows from some external file format and produces
 * normalised {@link LoadableRow} objects for the LoaderService.
 */
export interface ISourceLoader {
  /** Human-readable identifier (e.g. "seniorHome", "poseidon"). */
  readonly sourceName: string
  load(opts: { startRow: number; count: number }): Promise<LoadableRow[]>
}

/**
 * Optional post-pipeline writer that turns {@link RowLoadOutcome[]} into
 * a side-effect — typically a coloured Excel report or a log file.
 */
export interface ILoadOutputWriter {
  write(outcomes: import("@domain/entities.js").RowLoadOutcome[]): Promise<void>
}