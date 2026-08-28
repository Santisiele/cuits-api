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
import { logger } from "@logger.js"

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_DELAY_MS = 30_000
const MAX_DELAY_MS = 90_000

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Orchestrates the loading of a source into the graph.
 *
 * Two modes:
 *   - With enricher  → traditional pipeline: resolve identity via Nosis,
 *                       fetch relationship graph, throttle. Used by the
 *                       "conocidos" loaders.
 *   - Without enricher → lightweight pipeline: write nodes as-is, no Nosis
 *                       calls, no throttling. Used by "por conocer" loaders
 *                       where the input is already canonical.
 *
 * Progress logging: every row emits a "Processing [i/N]" line at start and
 * a "✓ Loaded" / "✗ Failed" line at end so long runs are observable.
 */
export class LoaderService {
  constructor(
    private readonly repository: IGraphRepository,
    private readonly enricher: IEnricher | null = null,
    private readonly writer: ILoadOutputWriter | null = null,
  ) {}

  /**
   * Runs a loader: reads rows, processes each, writes outcomes.
   */
  async run(loader: ISourceLoader, startRow: number, count: number): Promise<void> {
    const rows = await loader.load({ startRow, count })
    logger.info(`Loaded ${rows.length} rows from ${loader.sourceName}`)

    const outcomes: RowLoadOutcome[] = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!

      // Row-level progress line — surfaces the humans-readable label of the
      // first node in the row (usually there's only one anyway) plus the
      // source file's row number, so the log reads like the old xlsx loaders
      // did AND still tells you exactly which spreadsheet row is in play.
      const label = this.describeRow(row)
      logger.info(`[${i + 1}/${rows.length}] Processing row ${row.rowId}: ${label}`)

      const outcome = await this.processRow(row)
      outcomes.push(outcome)

      this.logRowOutcome(outcome, i, rows.length)

      // Inter-row throttling: only when we actually hit Nosis.
      // "Por conocer" loads finish instantly because they don't call out.
      if (this.enricher && i < rows.length - 1) {
        await this.sleepRandom("between rows")
      }
    }

    if (this.writer) {
      await this.writer.write(outcomes)
    }
  }

  // ─── Row processing ──────────────────────────────────────────────────────

  private async processRow(row: LoadableRow): Promise<RowLoadOutcome> {
    const outcomes: NodeLoadOutcome[] = []
    const resolvedTaxIds = new Map<string, string>()

    const roleEntries = Object.entries(row.nodes)
    for (let i = 0; i < roleEntries.length; i++) {
      const [roleKey, node] = roleEntries[i]!

      // Skip if this node depends on a role that failed earlier in the row.
      if (node.requiresRole) {
        const depTaxId = resolvedTaxIds.get(node.requiresRole)
        if (!depTaxId) {
          outcomes.push({ roleKey, status: "skipped_due_to_dependency" })
          continue
        }
      }

      const outcome = await this.processNode(roleKey, node, resolvedTaxIds)
      outcomes.push(outcome)

      // Intra-row throttling: only between Nosis-touching nodes.
      const hitEnricher = outcome.status === "loaded" && this.enricher !== null
      const moreNodes = i < roleEntries.length - 1
      if (hitEnricher && moreNodes) {
        await this.sleepRandom("between nodes in row")
      }
    }

    // Apply intra-row relationships (only meaningful if at least two nodes loaded).
    for (const rel of row.relationships) {
      const from = resolvedTaxIds.get(rel.fromKey)
      const to = resolvedTaxIds.get(rel.toKey)
      if (!from || !to) continue
      await this.repository.mergeRelationship({
        fromTaxId: from,
        toTaxId: to,
        relationshipType: rel.relationshipType,
      })
    }

    const overall = this.overallStatus(outcomes)
    return { rowId: row.rowId, row, nodes: outcomes, overall }
  }

  /**
   * Processes a single node within a row.
   *
   * Without enricher: write the node as-is (the loader is responsible for
   * providing a canonical taxId in `node.document`).
   *
   * With enricher: resolve identity via Nosis, then write and pull relations.
   */
  private async processNode(
    roleKey: string,
    node: NonNullable<LoadableRow["nodes"][string]>,
    resolvedTaxIds: Map<string, string>,
  ): Promise<NodeLoadOutcome> {
    const category = node.category ?? "known"

    // ── No enricher: take the document as canonical and write the node ──
    if (!this.enricher) {
      try {
        await this.repository.upsertBaseNode(
          node.document,
          node.businessName,
          node.source,
          node.attributes,
          category,
        )
        resolvedTaxIds.set(roleKey, node.document)
        return { roleKey, status: "loaded", resolvedTaxId: node.document }
      } catch (err) {
        logger.error({ err, roleKey, document: node.document }, "Failed to upsert base node")
        return { roleKey, status: "failed" }
      }
    }

    // ── With enricher: resolve, write, and pull the relationship graph ──
    try {
      const identity = await this.enricher.resolveDocument(node.document)
      if (!identity) return { roleKey, status: "not_found" }

      const taxId = identity.taxId
      await this.repository.upsertBaseNode(
        taxId,
        identity.businessName || node.businessName,
        node.source,
        node.attributes,
        category,
      )
      resolvedTaxIds.set(roleKey, taxId)

      const graph = await this.enricher.fetchRelationshipGraph(taxId, identity.businessName)
      let enrichmentNodeCount = 0
      for (const enrichmentNode of graph.nodes) {
        if (enrichmentNode.taxId === taxId) continue
        await this.repository.upsertEnrichmentNode(enrichmentNode.taxId, enrichmentNode.businessName)
        enrichmentNodeCount++
      }
      for (const rel of graph.relationships) {
        await this.repository.mergeRelationship(rel)
      }

      // Structured note so the row-level summary can report enrichment size
      // without having to re-count at the end.
      const notes = `${enrichmentNodeCount} related, ${graph.relationships.length} relationships`
      return { roleKey, status: "loaded", resolvedTaxId: taxId, notes }
    } catch (err) {
      logger.error({ err, roleKey, document: node.document }, "Failed to process node")
      return { roleKey, status: "failed" }
    }
  }

  // ─── Logging helpers ─────────────────────────────────────────────────────

  /**
   * Builds a short human-readable label for a row — used in the
   * "[i/N] Processing ..." line. Prefers "<name> (<document>)" from the
   * first node in the row.
   */
  private describeRow(row: LoadableRow): string {
    const firstNode: LoadableNode | undefined = Object.values(row.nodes)[0]
    if (!firstNode) return `row ${row.rowId}`
    const name = firstNode.businessName?.trim()
    return name
      ? `${name} (${firstNode.document})`
      : firstNode.document
  }

  /**
   * Emits a per-row summary line. Mirrors the "✓ Loaded" / "✗ Failed" style
   * of the old xlsx loaders so long runs are readable at a glance.
   */
  private logRowOutcome(outcome: RowLoadOutcome, index: number, total: number): void {
    const prefix = `[${index + 1}/${total}] row ${outcome.rowId}`

    if (outcome.overall === "all_loaded") {
      // Aggregate notes from all loaded nodes (usually just one).
      const notes = outcome.nodes
        .filter((n) => n.status === "loaded" && n.notes)
        .map((n) => n.notes)
        .join(" | ")
      logger.info(`${prefix} ✓ Loaded${notes ? ` — ${notes}` : ""}`)
      return
    }

    if (outcome.overall === "none") {
      const reasons = outcome.nodes.map((n) => `${n.roleKey}: ${n.status}`).join(", ")
      logger.warn(`${prefix} ✗ Failed — ${reasons}`)
      return
    }

    // Partial: some nodes loaded, some didn't
    const failed = outcome.nodes
      .filter((n) => n.status !== "loaded")
      .map((n) => `${n.roleKey}: ${n.status}`)
      .join(", ")
    logger.warn(`${prefix} ~ Partial — ${failed}`)
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private overallStatus(outcomes: NodeLoadOutcome[]): RowLoadOutcome["overall"] {
    const loadedCount = outcomes.filter((o) => o.status === "loaded").length
    if (loadedCount === outcomes.length) return "all_loaded"
    if (loadedCount === 0) return "none"
    return "partial"
  }

  private async sleepRandom(reason: string): Promise<void> {
    const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS)
    logger.info(`Sleeping ${Math.round(delay / 1000)}s (${reason})`)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}