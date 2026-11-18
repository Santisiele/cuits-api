import neo4j, { type Session } from "neo4j-driver"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import type { AssistantMessageResult, IAiChatRepository } from "@ports/interfaces.js"
import type { AiChat, AiChatMessage, ChatMessageStatus, ChatTable } from "@domain/aiChat.js"
import type { ResearchSource, ResearchUsage } from "@domain/webResearch.js"

const STATUSES: readonly ChatMessageStatus[] = ["running", "done", "failed", "budget_exhausted"]

function toNumber(value: unknown): number {
  if (neo4j.isInt(value)) return value.toNumber()
  return typeof value === "number" ? value : 0
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function parseList(value: unknown): unknown[] {
  try {
    const parsed: unknown = JSON.parse(toText(value))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function toSources(value: unknown): ResearchSource[] {
  return parseList(value).map((item) => {
    const source = item as { url?: unknown; title?: unknown }
    return { url: toText(source.url), title: toText(source.title) }
  })
}

function toTables(value: unknown): ChatTable[] {
  return parseList(value).map((item) => {
    const table = item as Partial<ChatTable>
    return {
      resultId: toText(table.resultId),
      title: toText(table.title),
      columns: Array.isArray(table.columns) ? table.columns.map(String) : [],
      rows: Array.isArray(table.rows) ? table.rows.filter(Array.isArray) : [],
      truncated: table.truncated === true,
    }
  })
}

function toChat(properties: Record<string, unknown>): AiChat {
  return {
    id: toText(properties["id"]),
    title: toText(properties["title"]),
    createdBy: toText(properties["createdBy"]),
    createdAt: toText(properties["createdAt"]),
    updatedAt: toText(properties["updatedAt"]),
    archivedAt: typeof properties["archivedAt"] === "string" ? properties["archivedAt"] : null,
  }
}

function toMessage(properties: Record<string, unknown>, chatId: unknown): AiChatMessage {
  const status = STATUSES.find((value) => value === properties["status"]) ?? "failed"
  return {
    id: toText(properties["id"]),
    chatId: toText(chatId),
    role: properties["role"] === "user" ? "user" : "assistant",
    createdAt: toText(properties["createdAt"]),
    text: toText(properties["text"]),
    sources: toSources(properties["sources"]),
    tables: toTables(properties["tables"]),
    status,
    model: toText(properties["model"]),
    inputTokens: toNumber(properties["inputTokens"]),
    outputTokens: toNumber(properties["outputTokens"]),
    cacheReadTokens: toNumber(properties["cacheReadTokens"]),
    webSearches: toNumber(properties["webSearches"]),
    costUsd: toNumber(properties["costUsd"]),
  }
}

function usageParams(usage: ResearchUsage) {
  return {
    inputTokens: neo4j.int(usage.inputTokens),
    outputTokens: neo4j.int(usage.outputTokens),
    cacheReadTokens: neo4j.int(usage.cacheReadTokens),
    webSearches: neo4j.int(usage.webSearches),
  }
}

export class Neo4jAiChatRepository implements IAiChatRepository {
  private async run<T>(work: (session: Session) => Promise<T>): Promise<T> {
    const session = Neo4jDriver.instance.session()
    try {
      return await work(session)
    } finally {
      await session.close()
    }
  }

  ensureSetup(): Promise<void> {
    return this.run(async (session) => {
      await session.run(Queries.AI_CHAT_CONSTRAINT)
      await session.run(Queries.AI_CHAT_MESSAGE_CONSTRAINT)
      await session.run(Queries.AI_CHAT_OWNER_INDEX)
      await session.run(Queries.AI_CHAT_MESSAGE_CREATED_INDEX)
    })
  }

  listChats(owner: string): Promise<AiChat[]> {
    return this.run(async (session) => {
      const result = await session.run(Queries.LIST_AI_CHATS, { owner })
      return result.records.map((record) => toChat(record.get("chat").properties))
    })
  }

  findChat(id: string): Promise<AiChat | null> {
    return this.run(async (session) => {
      const record = (await session.run(Queries.FIND_AI_CHAT, { id })).records[0]
      return record ? toChat(record.get("chat").properties) : null
    })
  }

  createChat(chat: AiChat): Promise<void> {
    return this.run(async (session) => {
      await session.run(Queries.CREATE_AI_CHAT, chat)
    })
  }

  archiveChat(id: string, archivedAt: string): Promise<void> {
    return this.run(async (session) => {
      await session.run(Queries.ARCHIVE_AI_CHAT, { id, archivedAt })
    })
  }

  listMessages(chatId: string): Promise<AiChatMessage[]> {
    return this.run(async (session) => {
      const result = await session.run(Queries.LIST_AI_CHAT_MESSAGES, { chatId })
      return result.records.map((record) => toMessage(record.get("message").properties, record.get("chatId")))
    })
  }

  findMessage(id: string): Promise<AiChatMessage | null> {
    return this.run(async (session) => {
      const record = (await session.run(Queries.FIND_AI_CHAT_MESSAGE, { id })).records[0]
      return record ? toMessage(record.get("message").properties, record.get("chatId")) : null
    })
  }

  addMessage(message: AiChatMessage, updatedAt: string): Promise<void> {
    return this.run(async (session) => {
      await session.run(Queries.ADD_AI_CHAT_MESSAGE, {
        ...message,
        ...usageParams(message),
        sources: JSON.stringify(message.sources),
        tables: JSON.stringify(message.tables),
        updatedAt,
      })
    })
  }

  recordUsage(messageId: string, model: string, usage: ResearchUsage, costUsd: number): Promise<void> {
    return this.run(async (session) => {
      await session.run(Queries.RECORD_AI_CHAT_USAGE, { id: messageId, model, ...usageParams(usage), costUsd })
    })
  }

  finishMessage(messageId: string, result: AssistantMessageResult): Promise<void> {
    return this.run(async (session) => {
      await session.run(Queries.FINISH_AI_CHAT_MESSAGE, {
        id: messageId,
        status: result.status,
        text: result.text,
        sources: JSON.stringify(result.sources),
        tables: JSON.stringify(result.tables),
        model: result.model,
        ...usageParams(result.usage),
        costUsd: result.costUsd,
      })
    })
  }

  failRunning(): Promise<number> {
    return this.run(async (session) => {
      const record = (await session.run(Queries.FAIL_RUNNING_AI_CHAT_MESSAGES)).records[0]
      return toNumber(record?.get("failed"))
    })
  }
}
