import type {
  IEnricher,
  EnrichmentIdentity,
  EnrichmentGraph,
} from "@ports/interfaces.js"
import type { GraphRelationship } from "@domain/entities.js"
import { NosisScraper } from "@scrapers/nosis.js"
import type { NosisRelation } from "@scrapers/nosis.js"

/**
 * Adapter implementing the {@link IEnricher} port using Nosis Manager as
 * the upstream identity + relationship-graph provider.
 *
 * Responsibilities:
 *  - Translate {@link IEnricher} method calls into Nosis API calls
 *  - Flatten Nosis's nested tree response into a flat (nodes, relationships) graph
 *
 * Construction is done via {@link NosisEnricher.create} which performs the
 * one-time Playwright login. The internal {@link NosisScraper} session is
 * reused across all subsequent calls.
 */
export class NosisEnricher implements IEnricher {
  private constructor(private readonly scraper: NosisScraper) {}

  /**
   * Authenticates against Nosis and returns a ready-to-use enricher.
   */
  static async create(): Promise<NosisEnricher> {
    const scraper = await NosisScraper.create()
    return new NosisEnricher(scraper)
  }

  /** @inheritdoc */
  async resolveDocument(document: string): Promise<EnrichmentIdentity | null> {
    return this.scraper.searchAndResolve(document)
  }

  /** @inheritdoc */
  async fetchRelationshipGraph(
    taxId: string,
    businessName: string
  ): Promise<EnrichmentGraph> {
    const relations = await this.scraper.fetchRelations(taxId, businessName)
    return this.flattenTree(relations)
  }

  // ─── Tree → flat graph ────────────────────────────────────────────────────

  /**
   * Flattens Nosis's nested response into a deduplicated list of nodes plus
   * a list of parent → child relationships. Cycles are broken by the visited
   * set, which Nosis's tree may legitimately contain.
   */
  private flattenTree(relations: NosisRelation[]): EnrichmentGraph {
    const nodes = new Map<string, { taxId: string; businessName: string }>()
    const relationships: GraphRelationship[] = []

    const visit = (relation: NosisRelation, parentTaxId?: string): void => {
      if (!nodes.has(relation.taxId)) {
        nodes.set(relation.taxId, {
          taxId: relation.taxId,
          businessName: relation.businessName,
        })
      }
      if (parentTaxId) {
        relationships.push({
          fromTaxId: parentTaxId,
          toTaxId: relation.taxId,
          relationshipType: relation.relationshipType,
        })
      }
      for (const child of relation.relations) visit(child, relation.taxId)
    }

    for (const root of relations) visit(root)

    return {
      nodes: Array.from(nodes.values()),
      relationships,
    }
  }
}