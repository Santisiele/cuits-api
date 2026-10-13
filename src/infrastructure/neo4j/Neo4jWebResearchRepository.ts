import neo4j, { type Session } from "neo4j-driver"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import type { IWebResearchRepository } from "@ports/interfaces.js"
import {
  DEFAULT_MONTHLY_LIMIT_USD,
  type ResearchSource,
  type WebResearch,
  type WebResearchWithName,
} from "@domain/webResearch.js"

function toNumber(value: unknown): number {
  if (neo4j.isInt(value)) return value.toNumber()
  return typeof value === "number" ? value : 0
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function toNullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function toSources(value: unknown): ResearchSource[] {
  try {
    const parsed: unknown = JSON.parse(toText(value))
    return Array.isArray(parsed)
      ? parsed.map((source: { url?: unknown; title?: unknown }) => ({ url: toText(source.url), title: toText(source.title) }))
      : []
  } catch {
    return []
  }
}

function toResearch(properties: Record<string, unknown>, taxId: unknown): WebResearch {
  return {
    id: toText(properties["id"]),
    taxId: toText(taxId),
    requestedAt: toText(properties["requestedAt"]),
    requestedBy: toText(properties["requestedBy"]),
    status: properties["status"] === "done" ? "done" : "failed",
    summary: toText(properties["summary"]),
    sources: toSources(properties["sources"]),
    model: toText(properties["model"]),
    inputTokens: toNumber(properties["inputTokens"]),
    outputTokens: toNumber(properties["outputTokens"]),
    cacheReadTokens: toNumber(properties["cacheReadTokens"]),
    webSearches: toNumber(properties["webSearches"]),
    costUsd: toNumber(properties["costUsd"]),
    archivedAt: toNullableText(properties["archivedAt"]),
    archivedBy: toNullableText(properties["archivedBy"]),
  }
}

export class Neo4jWebResearchRepository implements IWebResearchRepository {
  private session(): Session {
    return Neo4jDriver.instance.session()
  }

  private async run<T>(work: (session: Session) => Promise<T>): Promise<T> {
    const session = this.session()
    try {
      return await work(session)
    } finally {
      await session.close()
    }
  }

  findSubject(taxId: string) {
    return this.run(async (session) => {
      const record = (await session.run(Queries.FIND_RESEARCH_SUBJECT, { taxId })).records[0]
      if (!record) return null
      return { businessName: toText(record.get("businessName")), inMyBase: record.get("inMyBase") === true }
    })
  }

  save(research: WebResearch): Promise<void> {
    return this.run(async (session) => {
      await session.run(Queries.CREATE_WEB_RESEARCH, { ...research, sources: JSON.stringify(research.sources) })
    })
  }

  listForCuit(taxId: string): Promise<WebResearch[]> {
    return this.run(async (session) => {
      const result = await session.run(Queries.FIND_WEB_RESEARCH_FOR_CUIT, { taxId })
      return result.records.map((record) => toResearch(record.get("r").properties, record.get("taxId")))
    })
  }

  listRecent(limit: number): Promise<WebResearchWithName[]> {
    return this.listWithName(Queries.FIND_RECENT_WEB_RESEARCH, limit)
  }

  findById(id: string): Promise<WebResearch | null> {
    return this.run(async (session) => {
      const record = (await session.run(Queries.FIND_WEB_RESEARCH_BY_ID, { id })).records[0]
      return record ? toResearch(record.get("r").properties, record.get("taxId")) : null
    })
  }

  archive(id: string, archivedAt: string, archivedBy: string): Promise<void> {
    return this.run(async (session) => {
      await session.run(Queries.ARCHIVE_WEB_RESEARCH, { id, archivedAt, archivedBy })
    })
  }

  restore(id: string): Promise<void> {
    return this.run(async (session) => {
      await session.run(Queries.RESTORE_WEB_RESEARCH, { id })
    })
  }

  listArchived(limit: number): Promise<WebResearchWithName[]> {
    return this.listWithName(Queries.FIND_ARCHIVED_WEB_RESEARCH, limit)
  }

  private listWithName(query: string, limit: number): Promise<WebResearchWithName[]> {
    return this.run(async (session) => {
      const result = await session.run(query, { limit: neo4j.int(limit) })
      return result.records.map((record) => ({
        ...toResearch(record.get("r").properties, record.get("taxId")),
        businessName: toText(record.get("businessName")),
      }))
    })
  }

  getMonthlyLimit(): Promise<number> {
    return this.run(async (session) => {
      const value: unknown = (await session.run(Queries.FIND_AI_BUDGET)).records[0]?.get("monthlyLimitUsd")
      return value === undefined || value === null ? DEFAULT_MONTHLY_LIMIT_USD : toNumber(value)
    })
  }

  setMonthlyLimit(monthlyLimitUsd: number, updatedBy: string, updatedAt: string): Promise<void> {
    return this.run(async (session) => {
      await session.run(Queries.SET_AI_BUDGET, { monthlyLimitUsd, updatedBy, updatedAt })
    })
  }

  spendSince(since: string): Promise<{ totalUsd: number; count: number }> {
    return this.run(async (session) => {
      const record = (await session.run(Queries.SUM_WEB_RESEARCH_SINCE, { since })).records[0]
      return { totalUsd: toNumber(record?.get("totalUsd")), count: toNumber(record?.get("count")) }
    })
  }
}
