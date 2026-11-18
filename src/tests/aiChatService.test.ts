import { describe, it, expect, beforeEach } from "vitest"
import { AiChatService, type ChatRunReport } from "@application/AiChatService"
import { AssistantError } from "@domain/aiChat"
import type { ResearchBudget } from "@domain/webResearch"
import { FakeAssistant, FakeGraphReader, InMemoryAiChatRepository } from "./aiChatFakes"

const NOW = new Date("2026-11-18T15:00:00.000Z")
const OWNER = "santi"

function budgetOf(spent: number, limit = 20): ResearchBudget {
  return {
    monthlyLimitUsd: limit,
    spentThisMonthUsd: spent,
    researchCountThisMonth: 0,
    researchSpentThisMonthUsd: 0,
    chatSpentThisMonthUsd: spent,
    chatAnswerCountThisMonth: 0,
  }
}

describe("AiChatService", () => {
  let repository: InMemoryAiChatRepository
  let assistant: FakeAssistant
  let graph: FakeGraphReader
  let spent: number
  let reports: ChatRunReport[]
  let work: Promise<void>[]
  let ids: number

  function build(withAssistant = true): AiChatService {
    return new AiChatService(
      repository,
      withAssistant ? assistant : null,
      graph,
      async () => budgetOf(spent + repository.messages.reduce((sum, message) => sum + message.costUsd, 0)),
      (run) => reports.push(run),
      () => NOW,
      () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
      (task) => work.push(task())
    )
  }

  async function settle(): Promise<void> {
    await Promise.all(work)
  }

  beforeEach(() => {
    repository = new InMemoryAiChatRepository()
    assistant = new FakeAssistant()
    graph = new FakeGraphReader()
    spent = 0
    reports = []
    work = []
    ids = 0
  })

  it("starts a chat, answers in the background and records the cost", async () => {
    const service = build()
    const started = await service.start(OWNER, "  ¿Quiénes operan en bolsa?  ")
    expect(started.chat).toMatchObject({ title: "¿Quiénes operan en bolsa?", createdBy: OWNER, archivedAt: null })
    expect(started.messages.map((message) => [message.role, message.status, message.text])).toEqual([
      ["user", "done", "¿Quiénes operan en bolsa?"],
      ["assistant", "running", ""],
    ])

    await settle()
    const opened = await service.open(OWNER, started.chat.id)
    expect(opened.messages[1]).toMatchObject({ status: "done", text: "Encontré 1 empresa.", costUsd: 4, model: "claude-opus-5-5" })
    expect(assistant.turns[0]?.question).toBe("¿Quiénes operan en bolsa?")
    expect(assistant.turns[0]?.history).toEqual([])
    expect(reports).toEqual([{ username: OWNER, chatId: started.chat.id, status: "done", costUsd: 4, webSearches: 0, detail: null }])
  })

  it("keeps the tables Claude showed and passes them to the next question", async () => {
    assistant.script = async (turn) => {
      const query = await turn.executeTool("run_query", { cypher: "MATCH (c:CUIT) RETURN c.id AS cuit" })
      const { resultId } = JSON.parse(query.content)
      await turn.executeTool("show_table", { resultId, title: "Bolsa" })
      return { text: "Listo", sources: [], model: "m", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 }, stoppedForBudget: false }
    }
    const service = build()
    const { chat } = await service.start(OWNER, "listá")
    await settle()

    const tableId = repository.messages[1]?.tables[0]?.resultId ?? ""
    assistant.script = async (turn) => {
      const page = JSON.parse((await turn.executeTool("get_table", { resultId: tableId })).content)
      return { text: String(page.rowCount), sources: [], model: "m", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 }, stoppedForBudget: false }
    }
    await service.ask(OWNER, chat.id, "¿y de esos?")
    await settle()
    const { messages } = await service.open(OWNER, chat.id)
    expect(messages[1]?.tables).toHaveLength(1)
    expect(messages[1]?.tables[0]).toMatchObject({ title: "Bolsa", columns: ["cuit", "nombre"] })
    expect(messages[3]?.text).toBe("1")
    expect(assistant.turns[1]?.history).toEqual([
      { role: "user", text: "listá" },
      { role: "assistant", text: expect.stringContaining('"Bolsa", 1 filas') },
    ])
  })

  it("stops when the month runs out in the middle of an answer", async () => {
    assistant.script = async (turn) => {
      const usage = { inputTokens: 3_000_000, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 }
      const keepGoing = await turn.afterRound(usage, "claude-opus-5-5")
      return { text: keepGoing ? "sigue" : "parcial", sources: [], model: "claude-opus-5-5", usage, stoppedForBudget: !keepGoing }
    }
    spent = 9
    const service = build()
    const { chat } = await service.start(OWNER, "completá todo con la web")
    await settle()
    const { messages } = await service.open(OWNER, chat.id)
    expect(messages[1]).toMatchObject({ status: "budget_exhausted", text: "parcial", costUsd: 12 })
    expect(repository.usageLog).toEqual([
      { messageId: messages[1]?.id, model: "claude-opus-5-5", usage: expect.objectContaining({ inputTokens: 3_000_000 }), costUsd: 12 },
    ])
  })

  it("saves a failed answer with what it spent", async () => {
    assistant.script = async () => {
      throw new AssistantError("overloaded", { inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, webSearches: 1 }, "claude-opus-5-5")
    }
    const service = build()
    const { chat } = await service.start(OWNER, "hola")
    await settle()
    const { messages } = await service.open(OWNER, chat.id)
    expect(messages[1]).toMatchObject({ status: "failed", costUsd: 2.01, webSearches: 1 })
    expect(reports[0]).toMatchObject({ status: "failed", detail: "overloaded" })
  })

  it("refuses bad questions, a spent month and a missing key before creating anything", async () => {
    await expect(build().start(OWNER, "  ")).rejects.toMatchObject({ reason: "invalid_question" })
    await expect(build(false).start(OWNER, "hola")).rejects.toMatchObject({ reason: "research_off" })
    spent = 20
    await expect(build().start(OWNER, "hola")).rejects.toMatchObject({ reason: "budget_exhausted" })
    expect(repository.chats).toHaveLength(0)
  })

  function holdAnswers(): () => void {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = assistant.script
    assistant.script = async (turn) => {
      await gate
      return original(turn)
    }
    return release
  }

  it("refuses a new question while the previous answer runs", async () => {
    const release = holdAnswers()
    const service = build()
    const { chat } = await service.start(OWNER, "uno")
    await expect(service.ask(OWNER, chat.id, "dos")).rejects.toMatchObject({ reason: "chat_busy" })
    release()
    await settle()
    await expect(service.ask(OWNER, chat.id, "dos")).resolves.toBeTruthy()
  })

  it("never shows a chat or a message to another user, nor archived chats", async () => {
    const service = build()
    const { chat, messages } = await service.start(OWNER, "mío")
    await settle()
    await expect(service.open("diego", chat.id)).rejects.toMatchObject({ reason: "chat_not_found" })
    await expect(service.ask("diego", chat.id, "x")).rejects.toMatchObject({ reason: "chat_not_found" })
    await expect(service.message("diego", messages[1]?.id ?? "")).rejects.toMatchObject({ reason: "message_not_found" })
    expect(await service.list("diego")).toEqual([])
    await expect(service.open(OWNER, "not-a-uuid")).rejects.toMatchObject({ reason: "chat_not_found" })

    expect((await service.message(OWNER, messages[1]?.id ?? "")).status).toBe("done")
    await service.archive(OWNER, chat.id)
    expect(await service.list(OWNER)).toEqual([])
    await expect(service.open(OWNER, chat.id)).rejects.toMatchObject({ reason: "chat_not_found" })
  })

  it("marks answers interrupted by a restart as failed", async () => {
    holdAnswers()
    const service = build()
    await service.start(OWNER, "uno")
    expect(await service.failInterrupted()).toBe(1)
  })
})
