import neo4j from "neo4j-driver"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import type { IGraphReader } from "@ports/interfaces.js"
import type { QueryResult } from "@domain/aiChat.js"

export function plainValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (neo4j.isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString()
  if (neo4j.isNode(value)) return { _labels: value.labels, ...plainProperties(value.properties) }
  if (neo4j.isRelationship(value)) return { _type: value.type, ...plainProperties(value.properties) }
  if (neo4j.isPath(value)) {
    return value.segments.flatMap((segment, index) => [
      ...(index === 0 ? [plainValue(segment.start)] : []),
      plainValue(segment.relationship),
      plainValue(segment.end),
    ])
  }
  if (
    neo4j.isDate(value) ||
    neo4j.isDateTime(value) ||
    neo4j.isLocalDateTime(value) ||
    neo4j.isLocalTime(value) ||
    neo4j.isTime(value) ||
    neo4j.isDuration(value) ||
    neo4j.isPoint(value)
  ) {
    return value.toString()
  }
  if (Array.isArray(value)) return value.map(plainValue)
  if (typeof value === "object") return plainProperties(value as Record<string, unknown>)
  return value
}

function plainProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([key, inner]) => [key, plainValue(inner)]))
}

function driverParam(value: unknown): unknown {
  if (typeof value === "number" && Number.isInteger(value)) return neo4j.int(value)
  if (Array.isArray(value)) return value.map(driverParam)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, driverParam(inner)]))
  }
  return value
}

export class Neo4jGraphReader implements IGraphReader {
  async read(cypher: string, params: Record<string, unknown>, maxRows: number, timeoutMs: number): Promise<QueryResult> {
    const session = Neo4jDriver.instance.session({ defaultAccessMode: neo4j.session.READ })
    try {
      return await session.executeRead(
        async (tx) => {
          const result = tx.run(cypher, driverParam(params) as Record<string, unknown>)
          const rows: unknown[][] = []
          let columns: string[] = []
          let truncated = false
          for await (const record of result) {
            columns = [...record.keys].map(String)
            if (rows.length >= maxRows) {
              truncated = true
              break
            }
            rows.push(record.keys.map((key) => plainValue(record.get(key))))
          }
          if (rows.length === 0) columns = [...(await result.keys())].map(String)
          return { columns, rows, truncated }
        },
        { timeout: timeoutMs }
      )
    } finally {
      await session.close()
    }
  }
}
