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
  CrossingNode,
  PathSegment,
  SearchResult,
  AddRelationshipResult,
  DeleteRelationshipResult,
  UpdateNodeResult,
  GraphRelationship,
  LoadableRow,
  LoadableNodeAttributes,
  BirthdayResult,
  NameSearchResult,
  LoadableNodeCategory,
  SourceInfo
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

  /**
   * Nodes belonging to every source in `sources` at once, counting companies
   * that reach a source through a directly related node.
   */
  findCrossingNodes(sources: string[]): Promise<CrossingNode[]>
  findPathsToBase(taxId: string, maxDepth: number): Promise<SearchResult[] | null>
  findShortestPath(fromTaxId: string, toTaxId: string, maxDepth: number): Promise<PathSegment[] | null>
  findAllRelationships(taxId: string, maxDepth: number): Promise<SearchResult[] | null>
  findToKnowNodes(): Promise<CuitNodeSummary[]>
  findAllMyNodes(): Promise <CuitNodeSummary[]>

  /**
   * Finds nodes whose business name contains `query`, case-insensitively,
   * across the entire graph. `limit` caps the result set.
   */
  searchNodesByName(query: string, limit: number): Promise<NameSearchResult[]>

  /**
   * Lists every source registered in the graph, with its category
   * and the number of CuitNodes currently attached to it.
   *
   * Uses the (:Source) nodes as source of truth. The array
   * `CuitNode.sources` is a denormalised cache and should not be
   * scanned to build this list.
   */
  findSources(): Promise<SourceInfo[]>

  // ─── Source administration ──────────────────────────────────────────────
  //
  // The repository exposes single-batch primitives; the batching loop lives
  // in SourceAdminService. Keeping the loop out of the adapter is what lets
  // the service log progress and stop cleanly on failure.

  /** Counts CUITs attached to a given source. */
  countCuitsForSource(sourceName: string): Promise<number>

  /** Whether a source with this exact name exists. */
  checkSourceExists(sourceName: string): Promise<boolean>

  /**
   * Ids of every CUIT attached to a source, captured before a destructive
   * operation so the orphan sweep can be restricted to them.
   */
  findCuitIdsForSource(sourceName: string): Promise<string[]>

  /** Checks rename eligibility: source exists AND new name is free. */
  checkRenameEligibility(
    oldName: string,
    newName: string
  ): Promise<{ sourceExists: boolean; newNameExists: boolean }>

  /** Renames a Source node. Returns the preserved category. */
  renameSourceNode(oldName: string, newName: string): Promise<string>

  /**
   * Rewrites the cached sources array on up to `batchSize` affected CUITs.
   * Returns how many were processed; 0 means the rename is fully applied.
   */
  updateSourcesArrayForRenameBatch(
    oldName: string,
    newName: string,
    batchSize: number
  ): Promise<number>

  /** Checks merge eligibility: both sources exist and share a category. */
  checkMergeEligibility(
    sourceToKeep: string,
    sourceToDrop: string
  ): Promise<{
    keepExists: boolean
    dropExists: boolean
    keepCategory: string | null
    dropCategory: string | null
  }>

  /**
   * Migrates HAS_SOURCE from the dropped source to the kept one on up to
   * `batchSize` CUITs. Returns processed count; 0 means none are left.
   */
  mergeSourceRelationshipsBatch(
    sourceToKeep: string,
    sourceToDrop: string,
    batchSize: number
  ): Promise<number>

  /** Deletes the dropped source once all its attachments were migrated. */
  finalizeSourceMerge(sourceToDrop: string): Promise<void>

  /**
   * Detaches up to `batchSize` CUITs from a source and recalculates their
   * flags. Returns processed count; 0 means none are left.
   */
  deleteSourceRelationshipsBatch(
    sourceName: string,
    batchSize: number
  ): Promise<number>

  /** Deletes the source node after all its attachments are gone. */
  deleteSourceNode(sourceName: string): Promise<void>

  /**
   * Counts how many CUITs a delete of this source would leave orphaned.
   * Used to give a dry run a meaningful removal estimate.
   */
  countOrphansForSource(sourceName: string): Promise<number>

  /**
   * Deletes the CUITs among `taxIds` that ended up with no sources and no
   * link to the base. Returns how many were removed.
   */
  deleteOrphanedNodesBatch(taxIds: string[]): Promise<number>

  /** Checks add eligibility: node and source both exist. */
  checkAddEligibility(
    taxId: string,
    sourceName: string
  ): Promise<{ nodeExists: boolean; sourceExists: boolean }>

  /** Attaches a source to a single CUIT. Idempotent. */
  addSourceToNode(taxId: string, sourceName: string): Promise<void>

  /**
   * Checks move eligibility: the node exists, currently carries
   * `fromSource`, and `toSource` exists.
   */
  checkMoveEligibility(
    taxId: string,
    fromSource: string,
    toSource: string
  ): Promise<{ nodeExists: boolean; fromExists: boolean; toExists: boolean }>

  /** Moves a CUIT from one source to another, recalculating flags. */
  moveSourceOnNode(
    taxId: string,
    fromSource: string,
    toSource: string
  ): Promise<void>

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

  // Ingestion (used by LoaderService)

  /**
   * Upserts a base-group node.
   *
   * Additive semantics for isKnown / isToKnow flags: existing values
   * are preserved. Category-implied flag is only flipped TRUE, never
   * back to FALSE.
   *
   * Sources are stored in two places:
   *   - c.sources: string[] (denormalised cache for read paths)
   *   - (:Source {name})<-[:HAS_SOURCE]-(c) (source of truth)
   *
   * Both are updated atomically inside MERGE_BASE_NODE. When the
   * (:Source) is created for the first time, its category is set
   * from the caller's `category` argument; subsequent calls that
   * reference the same source do NOT overwrite the category.
   *
   * @param category - "known" (default) or "to_know". Determines the
   *                   isKnown/isToKnow flag on the node AND, on first
   *                   encounter of the source name, the category of
   *                   the (:Source) node.
   */
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