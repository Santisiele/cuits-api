import type { NosisRelation } from "@scrapers/nosis.js"

export interface FlatNode {
  taxId: string
  businessName: string
  relationshipType: string
  level: number
}

export function normalizeCuit(raw: unknown): string | null {
  if (raw == null) return null
  const digits = String(raw).replace(/\D/g, "")
  return digits.length === 11 ? digits : null
}

export function formatCuit(taxId: string): string {
  return `${taxId.slice(0, 2)}-${taxId.slice(2, 10)}-${taxId.slice(10)}`
}

function flattenChildren(children: NosisRelation[], level: number, result: FlatNode[]): void {
  for (const node of children) {
    result.push({
      taxId: node.taxId,
      businessName: node.businessName,
      relationshipType: node.relationshipType,
      level,
    })
    if (node.relations.length > 0) {
      flattenChildren(node.relations, level + 1, result)
    }
  }
}

export function buildFlatTree(relations: NosisRelation[]): FlatNode[] {
  const result: FlatNode[] = []
  for (const root of relations) {
    flattenChildren(root.relations, 1, result)
  }
  return result
}

export function maxLevel(flat: FlatNode[]): number {
  return flat.reduce((max, node) => Math.max(max, node.level), 0)
}

export function renderNode(node: FlatNode): string {
  return `${formatCuit(node.taxId)} - ${node.businessName} - ${node.relationshipType}`
}

export function levelRows(prefix: unknown[], flat: FlatNode[], depth: number): unknown[][] {
  const rows: unknown[][] = [[...prefix, ...new Array(depth).fill("")]]
  for (const node of flat) {
    const levelCells = new Array(depth).fill("")
    levelCells[node.level - 1] = renderNode(node)
    rows.push([...prefix, ...levelCells])
  }
  return rows
}

