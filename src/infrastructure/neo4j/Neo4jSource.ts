import type { ISource } from "@ports/interfaces.js"
import type { IGraphRepository } from "@ports/interfaces.js"
import type { SearchResult, CuitNode, CuitNodeUpdate, CuitNodeSummary, PathSegment, AddRelationshipResult, DeleteRelationshipResult, UpdateNodeResult, SourceInfo } from "@domain/entities.js"
import { Neo4jRepository } from "@infrastructure/neo4j/Neo4jRepository.js"

/**
 * Data source adapter for Neo4j.
 * Implements the {@link ISource} port by delegating all data access
 * to the {@link IGraphRepository} outbound port.
 *
 * This adapter is the bridge between the source-agnostic search pipeline
 * and the graph database infrastructure.
 */
export class Neo4jSource implements ISource {
  readonly name = "neo4j"
  private readonly repository: IGraphRepository

  /**
   * @param repository - Graph repository to use. Defaults to {@link Neo4jRepository}.
   *   Pass a mock in tests to avoid database calls.
   */
  constructor(repository: IGraphRepository = new Neo4jRepository()) {
    this.repository = repository
  }

  /**
   * Searches for a Tax ID in the Neo4j graph.
   *
   * - If the node has `inMyBase = true`, returns a single result with node info.
   * - Otherwise, returns all paths leading from the node to inMyBase nodes.
   * - Returns an empty array if the node exists but has no paths to base.
   * - Returns an empty array if the node does not exist.
   */
  async search(taxId: string, maxDepth = 3): Promise<SearchResult[]> {
    const results = await this.repository.findPathsToBase(taxId, maxDepth)
    return results ?? []
  }

  // ─── Graph-specific operations (exposed for use in routes) ─────────────────
  // These are not part of ISource but are available when the caller
  // has a reference to Neo4jSource specifically.

  findShortestPath(fromTaxId: string, toTaxId: string, maxDepth: number): Promise<PathSegment[] | null> {
    return this.repository.findShortestPath(fromTaxId, toTaxId, maxDepth)
  }

  findAllRelationships(taxId: string, maxDepth: number): Promise<SearchResult[] | null> {
    return this.repository.findAllRelationships(taxId, maxDepth)
  }

  findMyBaseNodes(): Promise<CuitNodeSummary[]> {
    return this.repository.findMyBaseNodes()
  }

  /**
   * Lists all "por conocer" nodes (isToKnow=true). Mirrors findMyBaseNodes
   * so the /graph/to-know route has a symmetric API to /graph/nodes.
   */
  findToKnowNodes(): Promise<CuitNodeSummary[]> {
    return this.repository.findToKnowNodes()
  }

  findAllMyNodes(): Promise<CuitNodeSummary[]> {
    return this.repository.findAllMyNodes()
  }

  findNode(taxId: string): Promise<CuitNode | null> {
    return this.repository.findNode(taxId)
  }

  updateNode(taxId: string, fields: CuitNodeUpdate): Promise<UpdateNodeResult> {
    return this.repository.updateNode(taxId, fields)
  }

  addRelationship(fromTaxId: string, toTaxId: string, relationshipType: string): Promise<AddRelationshipResult> {
    return this.repository.addRelationship(fromTaxId, toTaxId, relationshipType)
  }

  deleteRelationship(fromTaxId: string, toTaxId: string, relationshipType: string): Promise<DeleteRelationshipResult> {
    return this.repository.deleteRelationship(fromTaxId, toTaxId, relationshipType)
  }

  getRelationshipTypeName(code: number): string | null {
    return this.repository.getRelationshipTypeName(code)
  }

  validRelationshipCodes(): number[] {
    return this.repository.validRelationshipCodes()
  }

  findCompanyNodes(): Promise<CuitNodeSummary[]> {
    return this.repository.findCompanyNodes()
  }

  /**
   * Lists every source registered in the graph. Delegates to the
   * repository's findSources method.
   */
  findSources(): Promise<SourceInfo[]> {
    return this.repository.findSources()
  }

  /**
   * Returns every inMyBase node whose birthday falls in the given
   * (month, day) range. Delegates to the underlying repository.
   */
  async findBirthdaysBetween(
    fromMonth: number,
    fromDay: number,
    toMonth: number,
    toDay: number
  ): Promise<import("@domain/entities.js").BirthdayResult[]> {
    return this.repository.findBirthdaysBetween(fromMonth, fromDay, toMonth, toDay)
  }
}