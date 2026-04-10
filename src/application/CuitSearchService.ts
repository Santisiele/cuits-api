import type { ISource } from "@ports/interfaces.js"
import type { SearchResult } from "@domain/entities.js"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SearchAllSourcesResult {
  results: SearchResult[]
  failedCount: number
}

// ─── CUIT validation ──────────────────────────────────────────────────────────

const CUIT_REGEX = /^\d{2}-\d{8}-\d{1}$/

/**
 * Returns true if the given string is a validly formatted CUIT.
 * Expected format: XX-XXXXXXXX-X
 */
export function isValidCuit(cuit: string): boolean {
  return CUIT_REGEX.test(cuit)
}

// ─── Source registry ──────────────────────────────────────────────────────────

/**
 * Registry that holds all registered data source adapters.
 *
 * Centralises source management so that adding a new source only
 * requires registering it here — no changes to routes or handlers.
 */
export class SourceRegistry {
  private readonly sources: ISource[]

  constructor(sources: ISource[]) {
    this.sources = sources
  }

  /** Returns all registered sources. */
  all(): ISource[] {
    return this.sources
  }

  /** Returns the number of registered sources. */
  get count(): number {
    return this.sources.length
  }
}

// ─── Search service ───────────────────────────────────────────────────────────

/**
 * Application service that orchestrates CUIT searches across multiple sources.
 *
 * This class contains the core business logic for multi-source search:
 * - Fan out to all sources in parallel
 * - Tolerate individual source failures (partial results are valid)
 * - Aggregate and return results
 */
export class CuitSearchService {
  private readonly registry: SourceRegistry

  constructor(registry: SourceRegistry) {
    this.registry = registry
  }

  /**
   * Searches for a Tax ID across all registered sources in parallel.
   *
   * Individual source failures are silently ignored — the search
   * succeeds as long as at least one source responds. The caller
   * receives `failedCount` to decide whether to surface a warning.
   *
   * @param taxId - Tax ID to search for
   * @param maxDepth - Maximum graph traversal depth (passed to graph sources)
   */
  async searchAll(taxId: string, maxDepth?: number): Promise<SearchAllSourcesResult> {
    const settled = await Promise.allSettled(
      this.registry.all().map((source) => source.search(taxId, maxDepth))
    )

    const results = settled
      .filter((r): r is PromiseFulfilledResult<SearchResult[]> => r.status === "fulfilled")
      .flatMap((r) => r.value)

    const failedCount = settled.filter((r) => r.status === "rejected").length

    return { results, failedCount }
  }
}