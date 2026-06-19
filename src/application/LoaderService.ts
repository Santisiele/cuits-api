import type {
  IGraphRepository,
  IEnricher,
  ISourceLoader,
  ILoadOutputWriter,
} from "@ports/interfaces.js"
import type {
  LoadableRow,
  LoadableNode,
  NodeLoadOutcome,
  RowLoadOutcome,
} from "@domain/entities.js"
import { logger } from "@logger"

// ─── Config ───────────────────────────────────────────────────────────────────

interface LoaderServiceOptions {
  /** Minimum delay between successive enrichments, in ms. Default 30s. */
  minDelayMs?: number
  /** Maximum delay between successive enrichments, in ms. Default 90s. */
  maxDelayMs?: number
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Application service that orchestrates the full source ingestion pipeline.
 *
 * Responsibilities:
 *  - Ask a loader for rows to ingest
 *  - For each row, resolve every node's document via the enricher
 *  - Persist resolved nodes (as inMyBase) to the repository
 *  - Fetch each resolved node's relationship graph and persist it
 *  - Persist inter-node relationships explicitly declared by the loader
 *  - Aggregate per-row outcomes for the optional writer
 *
 * Throttling: a randomised delay in [minDelayMs, maxDelayMs] is applied
 * BETWEEN every pair of successive enricher calls — both within a row
 * (after each node that actually hit the enricher) AND between rows.
 * This is to avoid tripping rate-limit / anti-scraping heuristics on the
 * upstream provider, regardless of how many nodes a single row contains.
 *
 * Concrete adapters are injected via the constructor (DI), making the
 * service trivially testable with mocks.
 */
export class LoaderService {
  private readonly minDelayMs: number
  private readonly maxDelayMs: number

  constructor(
    private readonly repository: IGraphRepository,
    private readonly enricher: IEnricher,
    private readonly writer: ILoadOutputWriter | null = null,
    options: LoaderServiceOptions = {}
  ) {
    this.minDelayMs = options.minDelayMs ?? 30_000
    this.maxDelayMs = options.maxDelayMs ?? 90_000
  }

  /**
   * Runs the full ingestion pipeline for a single loader.
   *
   * @param loader  - The source loader supplying the rows
   * @param startRow - 1-based index of the first row to load
   * @param count   - Maximum number of rows to load
   */
  async run(
    loader: ISourceLoader,
    startRow: number,
    count: number
  ): Promise<RowLoadOutcome[]> {
    logger.info(`Loading rows from "${loader.sourceName}" (start=${startRow}, count=${count})`)
    const rows = await loader.load({ startRow, count })
    logger.info(`Loader yielded ${rows.length} rows`)

    const outcomes: RowLoadOutcome[] = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      logger.info(`[${i + 1}/${rows.length}] Processing row ${row.rowId}`)

      const outcome = await this.processRow(row)
      outcomes.push(outcome)

      if (i < rows.length - 1) await this.sleepRandom("before next row")
    }

    if (this.writer) {
      logger.info("Writing load outcomes via configured writer")
      await this.writer.write(outcomes)
    }

    return outcomes
  }

  // ─── Per-row pipeline ─────────────────────────────────────────────────────

  /**
   * Processes a single row: resolves each node's document, persists the
   * resolved nodes, scrapes their relationship graphs, and finally creates
   * the inter-node relationships the loader requested.
   *
   * Throttling within a row: after every node whose processing actually
   * reached the enricher (i.e. it wasn't skipped by a dependency rule),
   * we sleep before processing the next one. This is symmetric with the
   * inter-row sleep so the upstream provider sees evenly-spaced traffic
   * regardless of row size.
   */
  private async processRow(row: LoadableRow): Promise<RowLoadOutcome> {
    const nodeOutcomes: NodeLoadOutcome[] = []
    /** roleKey → resolved CUIT, used to resolve inter-node relationships. */
    const resolvedByRole = new Map<string, string>()

    const entries = Object.entries(row.nodes)
    /** Tracks whether a previous node in this row actually called the enricher,
     *  so we can decide whether to sleep before the current one. */
    let lastNodeHitEnricher = false

    for (let i = 0; i < entries.length; i++) {
      const [roleKey, node] = entries[i]!

      // Respect role-key dependencies: skip nodes whose prerequisite role
      // wasn't loaded in this row. This lets loaders express "load B only
      // if A succeeded" without putting source-specific policy here.
      if (node.requiresRole && !resolvedByRole.has(node.requiresRole)) {
        logger.warn(
          `  Skipping role "${roleKey}" — required role "${node.requiresRole}" was not loaded`
        )
        nodeOutcomes.push({
          roleKey,
          status: "skipped_due_to_dependency",
          notes: `Skipped because "${node.requiresRole}" was not loaded`,
        })
        // No enricher call happened — no throttling needed.
        continue
      }

      // Throttle between consecutive enricher hits within the same row.
      if (lastNodeHitEnricher) {
        await this.sleepRandom(`before role "${roleKey}"`)
      }

      const outcome = await this.processNode(roleKey, node, resolvedByRole)
      nodeOutcomes.push(outcome)
      if (outcome.status === "loaded" && outcome.resolvedTaxId) {
        resolvedByRole.set(roleKey, outcome.resolvedTaxId)
      }
      // Any outcome other than the early-skip above implies we called the
      // enricher at least once for this node.
      lastNodeHitEnricher = true
    }

    // Create the inter-node relationships declared by the loader,
    // but only between nodes that actually got loaded.
    for (const rel of row.relationships) {
      const from = resolvedByRole.get(rel.fromKey)
      const to = resolvedByRole.get(rel.toKey)
      if (!from || !to) {
        logger.warn(
          `  Skipping relationship ${rel.fromKey} → ${rel.toKey} ` +
          `(${from ? "from ok" : "from missing"}, ${to ? "to ok" : "to missing"})`
        )
        continue
      }
      try {
        await this.repository.mergeRelationship({
          fromTaxId: from,
          toTaxId: to,
          relationshipType: rel.relationshipType,
        })
        logger.info(`  ✓ Linked ${rel.fromKey} → ${rel.toKey} as "${rel.relationshipType}"`)
      } catch (err) {
        logger.error(`  ✗ Failed to link ${rel.fromKey} → ${rel.toKey}: ${(err as Error).message}`)
      }
    }

    return {
      rowId: row.rowId,
      row,
      nodes: nodeOutcomes,
      overall: this.summarise(nodeOutcomes),
    }
  }

  /**
   * Resolves a single node's document, persists the node, and brings in its
   * enrichment graph from the upstream provider.
   *
   * If resolution fails (document not found) the node is reported as
   * `not_found` and no persistence happens. If persistence itself fails, the
   * node is reported as `failed` with the error message attached.
   */
  private async processNode(
    roleKey: string,
    node: LoadableNode,
    resolvedSoFar: Map<string, string>
  ): Promise<NodeLoadOutcome> {
    logger.info(`  Role "${roleKey}": resolving document "${node.document}"`)

    let identity: { taxId: string; businessName: string } | null = null
    try {
      identity = await this.enricher.resolveDocument(node.document)
    } catch (err) {
      logger.error(`  ✗ resolve failed for "${node.document}": ${(err as Error).message}`)
      return { roleKey, status: "failed", notes: `Error resolving document: ${(err as Error).message}` }
    }

    if (!identity) {
      logger.warn(`  ✗ Document "${node.document}" not found in enricher`)
      return { roleKey, status: "not_found", notes: "Documento no encontrado" }
    }

    const taxId = identity.taxId
    const businessName = node.businessName.trim() || identity.businessName
    logger.info(`  → resolved to ${taxId}`)

    try {
      await this.repository.upsertBaseNode(taxId, businessName, node.source, node.attributes)

      const graph = await this.enricher.fetchRelationshipGraph(taxId, businessName)
      for (const n of graph.nodes) {
        await this.repository.upsertEnrichmentNode(n.taxId, n.businessName)
      }
      for (const rel of graph.relationships) {
        await this.repository.mergeRelationship(rel)
      }
      logger.info(`  ✓ Loaded ${taxId} (${graph.nodes.length} nodes, ${graph.relationships.length} rels)`)

      void resolvedSoFar
      return { roleKey, status: "loaded", resolvedTaxId: taxId }
    } catch (err) {
      logger.error(`  ✗ Persistence failed for ${taxId}: ${(err as Error).message}`)
      return {
        roleKey,
        status: "failed",
        resolvedTaxId: taxId,
        notes: `Error persistiendo: ${(err as Error).message}`,
      }
    }
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  /**
   * Aggregates per-node outcomes into a single row-level summary.
   */
  private summarise(outcomes: NodeLoadOutcome[]): RowLoadOutcome["overall"] {
    const loaded = outcomes.filter((o) => o.status === "loaded").length
    if (loaded === 0) return "none"
    if (loaded === outcomes.length) return "all_loaded"
    return "partial"
  }

  /**
   * Pauses for a random duration in [minDelayMs, maxDelayMs].
   * Mimics human-like browsing intervals to avoid tripping anti-scraping
   * heuristics on the upstream provider.
   *
   * @param reason - Free-text reason logged alongside the wait, useful for
   *                 disambiguating intra-row vs inter-row pauses in the log.
   */
  private sleepRandom(reason: string): Promise<void> {
    const ms = Math.floor(Math.random() * (this.maxDelayMs - this.minDelayMs + 1)) + this.minDelayMs
    logger.info(`  ... waiting ${(ms / 1000).toFixed(1)}s ${reason}`)
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}