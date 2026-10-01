import { describe, expect, it } from "vitest"
import type { NosisRelation } from "@scrapers/nosis.js"
import { buildFlatTree, levelRows, maxLevel } from "@helpers/relationTree.js"

function node(taxId: string, relations: NosisRelation[] = []): NosisRelation {
  return { taxId, businessName: `N${taxId.slice(-1)}`, relationshipType: "Socio", depth: 0, relations }
}

describe("buildFlatTree", () => {
  it("skips the searched root and keeps children under their parent", () => {
    const tree = [node("30000000001", [node("20000000002", [node("20000000003")]), node("20000000004")])]
    const flat = buildFlatTree(tree)
    expect(flat.map((n) => [n.taxId, n.level])).toEqual([
      ["20000000002", 1],
      ["20000000003", 2],
      ["20000000004", 1],
    ])
    expect(maxLevel(flat)).toBe(2)
  })
})

describe("levelRows", () => {
  it("writes the company row and one row per related node in its level column", () => {
    const flat = buildFlatTree([node("30000000001", [node("20000000002", [node("20000000003")])])])
    expect(levelRows(["30-00000000-1", "ACME"], flat, 2)).toEqual([
      ["30-00000000-1", "ACME", "", ""],
      ["30-00000000-1", "ACME", "20-00000000-2 - N2 - Socio", ""],
      ["30-00000000-1", "ACME", "", "20-00000000-3 - N3 - Socio"],
    ])
  })
})
