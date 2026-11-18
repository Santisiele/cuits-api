import { describe, it, expect } from "vitest"
import neo4j from "neo4j-driver"
import { plainValue } from "@infrastructure/neo4j/Neo4jGraphReader"

const { Node, Relationship, Path, PathSegment, Date: Neo4jDate } = neo4j.types

describe("plainValue", () => {
  it("turns driver values into plain JSON", () => {
    const company = new Node(neo4j.int(1), ["CUIT"], { id: "30712345678", levelOfTrust: neo4j.int(2) }, "e1")
    const person = new Node(neo4j.int(2), ["CUIT"], { id: "20111111112" }, "e2")
    const link = new Relationship(neo4j.int(3), neo4j.int(2), neo4j.int(1), "RELATED_TO", { type: "President" }, "r1", "e2", "e1")
    const path = new Path(person, company, [new PathSegment(person, link, company)])

    expect(plainValue(neo4j.int(7))).toBe(7)
    expect(plainValue(neo4j.int("9007199254740993"))).toBe("9007199254740993")
    expect(plainValue(company)).toEqual({ _labels: ["CUIT"], id: "30712345678", levelOfTrust: 2 })
    expect(plainValue(link)).toEqual({ _type: "RELATED_TO", type: "President" })
    expect(plainValue(path)).toEqual([
      { _labels: ["CUIT"], id: "20111111112" },
      { _type: "RELATED_TO", type: "President" },
      { _labels: ["CUIT"], id: "30712345678", levelOfTrust: 2 },
    ])
    expect(plainValue(new Neo4jDate(2026, 11, 18))).toBe("2026-11-18")
    expect(plainValue({ n: neo4j.int(1), list: [neo4j.int(2), null] })).toEqual({ n: 1, list: [2, null] })
    expect(plainValue(undefined)).toBeNull()
  })
})
