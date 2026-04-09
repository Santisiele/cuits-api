/**
 * Represents a single search result from any data source
 */
export interface SearchResult {
  /** The CUIT number found */
  cuit: string
  /** Name of the source (e.g. "sharepoint-bolsa", "csv-clientes") */
  source: string
  /** File where the CUIT was found */
  file: string
  /** Raw data from the source, structure varies per source */
  data: Record<string, unknown>
}

/**
 * Contract that every data source must implement
 */
export interface ISource {
  /** Unique identifier for this source */
  name: string
  /**
   * Searches for a CUIT across this source
   * @param cuit - The CUIT number to search for
   * @param maxDepth - Maximum path depth for graph traversal (only used by graph-based sources)
   * @returns Array of results found in this source
   */
  search(cuit: string, maxDepth?: number): Promise<SearchResult[]>
}

/**
 * Represents a node in a path
 */
export interface PathNodeInfo {
  taxId: string
  businessName: string
  inMyBase: boolean
}

/**
 * Represents a segment between two nodes with all their relationships
 */
export interface PathSegment {
  from: PathNodeInfo
  to: PathNodeInfo
  relationships: string[]
}