import type { NosisRelation } from "@scrapers/nosis.js"

/**
 * Represents a node ready to be inserted into Neo4j
 */
export interface GraphNode {
  taxId: string
  businessName: string
}

/**
 * Represents a relationship ready to be inserted into Neo4j
 */
export interface GraphRelationship {
  fromTaxId: string
  toTaxId: string
  relationshipType: string
}

/**
 * Result of mapping a Nosis tree to graph format
 */
export interface GraphData {
  nodes: GraphNode[]
  relationships: GraphRelationship[]
}

/**
 * Flattens a Nosis relationship tree into nodes and relationships
 * ready to be inserted into Neo4j
 * @param relations - Nosis relationship tree
 */
export function mapToGraph(relations: NosisRelation[]): GraphData {
  const nodes = new Map<string, GraphNode>()
  const relationships: GraphRelationship[] = []

  function traverse(relation: NosisRelation, parentTaxId?: string) {
    // Add node if not already present
    if (!nodes.has(relation.taxId)) {
      nodes.set(relation.taxId, {
        taxId: relation.taxId,
        businessName: relation.businessName,
      })
    }

    // Add relationship to parent if exists
    if (parentTaxId) {
      relationships.push({
        fromTaxId: parentTaxId,
        toTaxId: relation.taxId,
        relationshipType: relation.relationshipType,
      })
    }

    // Traverse children
    for (const child of relation.relations) {
      traverse(child, relation.taxId)
    }
  }

  for (const relation of relations) {
    traverse(relation)
  }

  return {
    nodes: Array.from(nodes.values()),
    relationships,
  }
}