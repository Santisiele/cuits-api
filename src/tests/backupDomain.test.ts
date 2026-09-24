import { describe, it, expect } from "vitest"
import {
  chunk,
  groupByLabels,
  groupByType,
  isIntSentinel,
  isSafeGraphName,
  intSentinel,
  parseBackup,
  summarise,
  type BackupNode,
  type BackupRelationship,
} from "@domain/backup"

function node(key: string, labels: string[]): BackupNode {
  return { key, labels, properties: {} }
}

function relationship(from: string, to: string, type: string): BackupRelationship {
  return { from, to, type, properties: {} }
}

describe("chunk", () => {
  it("splits a list into batches of the size given", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it("leaves a short list in one batch", () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]])
  })

  it("gives no batches for an empty list", () => {
    expect(chunk([], 10)).toEqual([])
  })

  it("refuses a batch size of zero, which would loop forever", () => {
    expect(() => chunk([1], 0)).toThrow()
  })
})

describe("groupByLabels", () => {
  it("puts the nodes of each label together", () => {
    const groups = groupByLabels([node("1", ["CUIT"]), node("2", ["Source"]), node("3", ["CUIT"])])
    expect(groups.get("CUIT")).toHaveLength(2)
    expect(groups.get("Source")).toHaveLength(1)
  })

  it("treats the same labels in another order as one group", () => {
    const groups = groupByLabels([node("1", ["CUIT", "Person"]), node("2", ["Person", "CUIT"])])
    expect([...groups.keys()]).toEqual(["CUIT:Person"])
  })
})

describe("groupByType", () => {
  it("puts each relationship type together", () => {
    const groups = groupByType([
      relationship("1", "2", "HAS_SOURCE"),
      relationship("1", "3", "RELATED_TO"),
      relationship("2", "3", "HAS_SOURCE"),
    ])
    expect(groups.get("HAS_SOURCE")).toHaveLength(2)
    expect(groups.get("RELATED_TO")).toHaveLength(1)
  })
})

describe("isSafeGraphName", () => {
  it("accepts the labels this graph uses", () => {
    for (const label of ["CUIT", "Source", "TrustLevel", "KeepAlive", "HAS_SOURCE", "RELATED_TO"]) {
      expect(isSafeGraphName(label)).toBe(true)
    }
  })

  it("refuses anything that could break out of the query", () => {
    for (const label of ["CUIT) DETACH DELETE (n", "with space", "", "1CUIT", "a-b"]) {
      expect(isSafeGraphName(label)).toBe(false)
    }
  })
})

describe("the integer marker", () => {
  it("recognises what it writes", () => {
    expect(isIntSentinel(intSentinel("4"))).toBe(true)
  })

  it("keeps negative numbers", () => {
    expect(isIntSentinel(intSentinel("-4"))).toBe(true)
  })

  it("does not mistake an ordinary object for one", () => {
    expect(isIntSentinel({ $int: "cuatro" })).toBe(false)
    expect(isIntSentinel({ low: 4, high: 0 })).toBe(false)
    expect(isIntSentinel(4)).toBe(false)
    expect(isIntSentinel(null)).toBe(false)
  })
})

describe("parseBackup", () => {
  const good = JSON.stringify({
    exportedAt: "2026-09-24T18:00:00.000Z",
    nodes: [{ key: "n1", labels: ["CUIT"], properties: { id: "30500904557" } }],
    relationships: [{ from: "n1", to: "n1", type: "RELATED_TO", properties: {} }],
  })

  it("reads a backup this app wrote", () => {
    const backup = parseBackup(good)
    expect(backup.nodes).toHaveLength(1)
    expect(backup.relationships).toHaveLength(1)
    expect(backup.exportedAt).toBe("2026-09-24T18:00:00.000Z")
  })

  it("refuses something that is not JSON", () => {
    expect(() => parseBackup("{ not json")).toThrow(/readable JSON/i)
  })

  it("refuses a file with no nodes list", () => {
    expect(() => parseBackup(JSON.stringify({ relationships: [] }))).toThrow(/no nodes/i)
  })

  it("refuses a node with no key", () => {
    expect(() =>
      parseBackup(JSON.stringify({ nodes: [{ labels: ["CUIT"] }], relationships: [] }))
    ).toThrow(/without a key/i)
  })

  it("refuses a label that could be Cypher rather than a name", () => {
    expect(() =>
      parseBackup(JSON.stringify({ nodes: [{ key: "n1", labels: ["CUIT) DETACH DELETE (n"] }], relationships: [] }))
    ).toThrow(/unsafe label/i)
  })

  it("refuses a relationship type that could be Cypher", () => {
    expect(() =>
      parseBackup(
        JSON.stringify({
          nodes: [],
          relationships: [{ from: "a", to: "b", type: "X]->() DETACH DELETE (n) //", properties: {} }],
        })
      )
    ).toThrow(/unsafe relationship/i)
  })

  it("refuses a relationship missing an end", () => {
    expect(() =>
      parseBackup(JSON.stringify({ nodes: [], relationships: [{ from: "a", type: "RELATED_TO" }] }))
    ).toThrow(/both ends/i)
  })

  it("survives a backup with no date", () => {
    expect(parseBackup(JSON.stringify({ nodes: [], relationships: [] })).exportedAt).toBe("")
  })
})

describe("summarise", () => {
  it("counts what the backup holds", () => {
    expect(
      summarise({ exportedAt: "", nodes: [node("1", ["CUIT"])], relationships: [relationship("1", "1", "RELATED_TO")] })
    ).toBe("1 nodes and 1 relationships")
  })
})
