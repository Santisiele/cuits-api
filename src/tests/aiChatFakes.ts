import type { AssistantMessageResult, IAiChatRepository, IChatAssistant, IGraphReader } from "@ports/interfaces"
import type { AiChat, AiChatMessage, ChatAnswer, ChatTurn, QueryResult } from "@domain/aiChat"
import type { ResearchUsage } from "@domain/webResearch"

export class InMemoryAiChatRepository implements IAiChatRepository {
  readonly chats: AiChat[] = []
  readonly messages: AiChatMessage[] = []
  readonly usageLog: { messageId: string; model: string; usage: ResearchUsage; costUsd: number }[] = []
  setUpCalls = 0

  async ensureSetup(): Promise<void> {
    this.setUpCalls++
  }

  async listChats(owner: string): Promise<AiChat[]> {
    return this.chats
      .filter((chat) => chat.createdBy === owner && chat.archivedAt === null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async findChat(id: string): Promise<AiChat | null> {
    return this.chats.find((chat) => chat.id === id) ?? null
  }

  async createChat(chat: AiChat): Promise<void> {
    this.chats.push({ ...chat })
  }

  async archiveChat(id: string, archivedAt: string): Promise<void> {
    const chat = this.chats.find((item) => item.id === id)
    if (chat) chat.archivedAt = archivedAt
  }

  async listMessages(chatId: string): Promise<AiChatMessage[]> {
    return this.messages.filter((message) => message.chatId === chatId).map((message) => ({ ...message }))
  }

  async findMessage(id: string): Promise<AiChatMessage | null> {
    const message = this.messages.find((item) => item.id === id)
    return message ? { ...message } : null
  }

  async addMessage(message: AiChatMessage, updatedAt: string): Promise<void> {
    this.messages.push({ ...message })
    const chat = this.chats.find((item) => item.id === message.chatId)
    if (chat) chat.updatedAt = updatedAt
  }

  async recordUsage(messageId: string, model: string, usage: ResearchUsage, costUsd: number): Promise<void> {
    this.usageLog.push({ messageId, model, usage, costUsd })
    this.patch(messageId, { model, ...usage, costUsd })
  }

  async finishMessage(messageId: string, result: AssistantMessageResult): Promise<void> {
    const { usage, ...rest } = result
    this.patch(messageId, { ...rest, ...usage })
  }

  async failRunning(): Promise<number> {
    const running = this.messages.filter((message) => message.status === "running")
    for (const message of running) message.status = "failed"
    return running.length
  }

  private patch(id: string, changes: Partial<AiChatMessage>): void {
    const index = this.messages.findIndex((message) => message.id === id)
    const current = this.messages[index]
    if (current) this.messages[index] = { ...current, ...changes }
  }
}

export class FakeGraphReader implements IGraphReader {
  readonly calls: { cypher: string; params: Record<string, unknown>; maxRows: number; timeoutMs: number }[] = []
  result: QueryResult = { columns: ["cuit", "nombre"], rows: [["30712345678", "ACME SA"]], truncated: false }
  failure: Error | null = null

  async read(cypher: string, params: Record<string, unknown>, maxRows: number, timeoutMs: number): Promise<QueryResult> {
    this.calls.push({ cypher, params, maxRows, timeoutMs })
    if (this.failure) throw this.failure
    return this.result
  }
}

export type AssistantScript = (turn: ChatTurn) => Promise<ChatAnswer>

export class FakeAssistant implements IChatAssistant {
  readonly turns: ChatTurn[] = []

  constructor(
    public script: AssistantScript = async () => ({
      text: "Encontré 1 empresa.",
      sources: [],
      model: "claude-opus-5-5",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 },
      stoppedForBudget: false,
    })
  ) {}

  answer(turn: ChatTurn): Promise<ChatAnswer> {
    this.turns.push(turn)
    return this.script(turn)
  }
}
