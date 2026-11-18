import { randomUUID } from "crypto"
import type { IAiChatRepository, IChatAssistant, IGraphReader } from "@ports/interfaces.js"
import { ChatToolbox } from "@application/ChatToolbox.js"
import {
  AssistantError,
  chatTitle,
  emptyUsage,
  historyFrom,
  normaliseQuestion,
  type AiChat,
  type AiChatMessage,
  type AiChatRejection,
  type ChatMessageStatus,
} from "@domain/aiChat.js"
import { costFromUsage, isBudgetExhausted, type ResearchBudget, type ResearchUsage } from "@domain/webResearch.js"

export class AiChatError extends Error {
  constructor(readonly reason: AiChatRejection, message: string) {
    super(message)
    this.name = "AiChatError"
  }
}

export interface ChatWithMessages {
  chat: AiChat
  messages: AiChatMessage[]
}

export interface ChatRunReport {
  username: string
  chatId: string
  status: ChatMessageStatus
  costUsd: number
  webSearches: number
  detail: string | null
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class AiChatService {
  private readonly busy = new Set<string>()

  constructor(
    private readonly repository: IAiChatRepository,
    private readonly assistant: IChatAssistant | null,
    private readonly graph: IGraphReader,
    private readonly budget: () => Promise<ResearchBudget>,
    private readonly report: (run: ChatRunReport) => void = () => {},
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly inBackground: (work: () => Promise<void>) => void = (work) => void work()
  ) {}

  list(owner: string): Promise<AiChat[]> {
    return this.repository.listChats(owner)
  }

  async open(owner: string, chatId: string): Promise<ChatWithMessages> {
    const chat = await this.ownChat(owner, chatId)
    return { chat, messages: await this.repository.listMessages(chat.id) }
  }

  async message(owner: string, messageId: string): Promise<AiChatMessage> {
    const message = ID_PATTERN.test(messageId) ? await this.repository.findMessage(messageId) : null
    if (!message) throw new AiChatError("message_not_found", "That message does not exist")
    await this.ownChat(owner, message.chatId).catch(() => {
      throw new AiChatError("message_not_found", "That message does not exist")
    })
    return message
  }

  async start(owner: string, question: unknown): Promise<ChatWithMessages> {
    const text = await this.checkQuestion(question)
    const createdAt = this.now().toISOString()
    const chat: AiChat = { id: this.newId(), title: chatTitle(text), createdBy: owner, createdAt, updatedAt: createdAt, archivedAt: null }
    await this.repository.createChat(chat)
    return this.launch(owner, chat, [], text)
  }

  async ask(owner: string, chatId: string, question: unknown): Promise<ChatWithMessages> {
    const chat = await this.ownChat(owner, chatId)
    const text = await this.checkQuestion(question)
    const earlier = await this.repository.listMessages(chat.id)
    if (this.busy.has(chat.id) || earlier.some((message) => message.status === "running")) {
      throw new AiChatError("chat_busy", "The previous answer is still running")
    }
    return this.launch(owner, chat, earlier, text)
  }

  async archive(owner: string, chatId: string): Promise<AiChat> {
    const chat = await this.ownChat(owner, chatId)
    const archivedAt = this.now().toISOString()
    await this.repository.archiveChat(chat.id, archivedAt)
    return { ...chat, archivedAt }
  }

  failInterrupted(): Promise<number> {
    return this.repository.failRunning()
  }

  private async checkQuestion(question: unknown): Promise<string> {
    const text = normaliseQuestion(question)
    if (text === null) throw new AiChatError("invalid_question", "The question must have between 1 and 4000 characters")
    if (!this.assistant) throw new AiChatError("research_off", "The AI assistant is not configured")
    const budget = await this.budget()
    if (isBudgetExhausted(budget.spentThisMonthUsd, budget.monthlyLimitUsd)) {
      throw new AiChatError("budget_exhausted", "The monthly spending limit has been reached")
    }
    return text
  }

  private async ownChat(owner: string, chatId: string): Promise<AiChat> {
    const chat = ID_PATTERN.test(chatId) ? await this.repository.findChat(chatId) : null
    if (!chat || chat.createdBy !== owner || chat.archivedAt !== null) {
      throw new AiChatError("chat_not_found", "That conversation does not exist")
    }
    return chat
  }

  private blankMessage(chatId: string, role: AiChatMessage["role"], text: string, status: ChatMessageStatus): AiChatMessage {
    return {
      id: this.newId(),
      chatId,
      role,
      createdAt: this.now().toISOString(),
      text,
      sources: [],
      tables: [],
      status,
      model: "",
      ...emptyUsage(),
      costUsd: 0,
    }
  }

  private async launch(owner: string, chat: AiChat, earlier: AiChatMessage[], text: string): Promise<ChatWithMessages> {
    const question = this.blankMessage(chat.id, "user", text, "done")
    await this.repository.addMessage(question, question.createdAt)
    const answer = this.blankMessage(chat.id, "assistant", "", "running")
    await this.repository.addMessage(answer, answer.createdAt)
    this.busy.add(chat.id)
    this.inBackground(() => this.run(owner, chat.id, answer.id, earlier, text).finally(() => this.busy.delete(chat.id)))
    return { chat: { ...chat, updatedAt: answer.createdAt }, messages: [...earlier, question, answer] }
  }

  private async run(owner: string, chatId: string, messageId: string, earlier: AiChatMessage[], question: string): Promise<void> {
    const toolbox = new ChatToolbox(this.graph, earlier.flatMap((message) => message.tables))
    let model = ""
    const progress = async (usage: ResearchUsage, roundModel: string): Promise<boolean> => {
      model = roundModel
      await this.repository.recordUsage(messageId, model, usage, costFromUsage(usage))
      const budget = await this.budget()
      return !isBudgetExhausted(budget.spentThisMonthUsd, budget.monthlyLimitUsd)
    }
    try {
      if (!this.assistant) throw new AssistantError("The AI assistant is not configured", emptyUsage(), "")
      const answer = await this.assistant.answer({
        history: historyFrom(earlier),
        question,
        executeTool: toolbox.execute,
        afterRound: progress,
      })
      const status: ChatMessageStatus = answer.stoppedForBudget ? "budget_exhausted" : "done"
      await this.finish(owner, chatId, messageId, status, answer.text, answer.sources, toolbox, answer.model, answer.usage, null)
    } catch (err) {
      const usage = err instanceof AssistantError ? err.usage : emptyUsage()
      const failedModel = err instanceof AssistantError ? err.model : model
      const detail = err instanceof Error ? err.message : String(err)
      await this.finish(owner, chatId, messageId, "failed", "", [], toolbox, failedModel, usage, detail).catch(() => {})
    }
  }

  private async finish(
    owner: string,
    chatId: string,
    messageId: string,
    status: ChatMessageStatus,
    text: string,
    sources: AiChatMessage["sources"],
    toolbox: ChatToolbox,
    model: string,
    usage: ResearchUsage,
    detail: string | null
  ): Promise<void> {
    const costUsd = costFromUsage(usage)
    await this.repository.finishMessage(messageId, { status, text, sources, tables: toolbox.tables(), model, usage, costUsd })
    this.report({ username: owner, chatId, status, costUsd, webSearches: usage.webSearches, detail })
  }
}
