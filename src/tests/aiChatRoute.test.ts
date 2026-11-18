import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { schemas } from "@schemas.js"
import type { Role } from "@domain/users"
import { FakeAssistant, FakeGraphReader, InMemoryAiChatRepository } from "./aiChatFakes"
import { InMemoryWebResearchRepository } from "./webResearchFakes"

const state = {
  chats: new InMemoryAiChatRepository(),
  research: new InMemoryWebResearchRepository(),
  assistant: new FakeAssistant(),
  graph: new FakeGraphReader(),
  apiKey: "test-key",
}

vi.mock("@config.js", () => ({
  config: {
    anthropic: {
      get apiKey() {
        return state.apiKey
      },
    },
  },
}))

vi.mock("@infrastructure/neo4j/Neo4jAiChatRepository.js", () => ({
  Neo4jAiChatRepository: class {
    constructor() {
      return new Proxy(
        {},
        {
          get: (_target, key) => {
            const value = Reflect.get(state.chats, key)
            return typeof value === "function" ? value.bind(state.chats) : value
          },
        }
      )
    }
  },
}))

vi.mock("@infrastructure/neo4j/Neo4jWebResearchRepository.js", () => ({
  Neo4jWebResearchRepository: class {
    getMonthlyLimit() { return state.research.getMonthlyLimit() }
    spendSince(since: string) { return state.research.spendSince(since) }
    chatSpendSince(since: string) { return state.research.chatSpendSince(since) }
  },
}))

vi.mock("@infrastructure/neo4j/Neo4jGraphReader.js", () => ({
  Neo4jGraphReader: class {
    read(...args: Parameters<FakeGraphReader["read"]>) { return state.graph.read(...args) }
  },
}))

vi.mock("@infrastructure/anthropic/ClaudeChatAssistant.js", () => ({
  ClaudeChatAssistant: {
    withApiKey: () => ({ answer: (...args: Parameters<FakeAssistant["answer"]>) => state.assistant.answer(...args) }),
  },
}))

vi.mock("@auth/activityLogger.js", () => ({
  logForbidden: vi.fn(),
  logAiChatAnswer: vi.fn(),
}))

const { default: aiChatRoutes } = await import("@routes/aiChat")
const { logAiChatAnswer, logForbidden } = await import("@auth/activityLogger.js")

async function buildApp(role: Role, username = "santi"): Promise<FastifyInstance> {
  const app = Fastify()
  for (const schema of Object.values(schemas)) app.addSchema(schema)
  await app.register(async (instance) => {
    instance.addHook("preHandler", async (request) => {
      request.username = username
      request.role = role
    })
    await instance.register(aiChatRoutes)
  })
  await app.ready()
  return app
}

async function waitForAnswer(app: FastifyInstance, messageId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await app.inject({ method: "GET", url: `/ai-chat/messages/${messageId}` })
    if (response.json().status !== "running") return response.json()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("the answer never finished")
}

describe("AI chat routes", () => {
  beforeEach(() => {
    state.chats = new InMemoryAiChatRepository()
    state.research = new InMemoryWebResearchRepository()
    state.assistant = new FakeAssistant(async (turn) => {
      const query = JSON.parse((await turn.executeTool("run_query", { cypher: "MATCH (c:CUIT) RETURN c.id" })).content)
      await turn.executeTool("show_table", { resultId: query.resultId, title: "Empresas" })
      return {
        text: "Acá está el listado.",
        sources: [{ url: "https://boletin.gob.ar", title: "BO" }],
        model: "claude-opus-5-5",
        usage: { inputTokens: 250_000, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 },
        stoppedForBudget: false,
      }
    })
    state.graph = new FakeGraphReader()
    state.apiKey = "test-key"
    vi.mocked(logAiChatAnswer).mockClear()
    vi.mocked(logForbidden).mockClear()
  })

  it("starts a chat, lets the front poll the answer and lists the chat", async () => {
    const app = await buildApp("admin")
    const created = await app.inject({ method: "POST", url: "/ai-chat", payload: { question: "Empresas de la bolsa" } })
    expect(created.statusCode).toBe(201)
    const body = created.json()
    expect(body.chat).toEqual({
      id: expect.any(String),
      title: "Empresas de la bolsa",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      archivedAt: null,
    })
    expect(body.messages.map((message: { status: string }) => message.status)).toEqual(["done", "running"])

    const answer = await waitForAnswer(app, body.messages[1].id)
    expect(answer).toMatchObject({
      status: "done",
      text: "Acá está el listado.",
      costUsd: 1,
      sources: [{ url: "https://boletin.gob.ar", title: "BO" }],
      tables: [
        { title: "Empresas", columns: ["cuit", "nombre"], rows: [["30712345678", "ACME SA"]], truncated: false, resultId: expect.any(String) },
      ],
    })
    expect(answer).not.toHaveProperty("inputTokens")
    expect(logAiChatAnswer).toHaveBeenCalledWith(expect.objectContaining({ username: "santi", status: "done", costUsd: 1 }))

    const list = await app.inject({ method: "GET", url: "/ai-chat" })
    expect(list.json().chats.map((chat: { id: string }) => chat.id)).toEqual([body.chat.id])

    const opened = await app.inject({ method: "GET", url: `/ai-chat/${body.chat.id}` })
    expect(opened.json().messages).toHaveLength(2)

    const followUp = await app.inject({ method: "POST", url: `/ai-chat/${body.chat.id}/messages`, payload: { question: "¿y?" } })
    expect(followUp.statusCode).toBe(201)
    expect(followUp.json().messages).toHaveLength(4)
    await waitForAnswer(app, followUp.json().messages[3].id)

    const archived = await app.inject({ method: "POST", url: `/ai-chat/${body.chat.id}/archive` })
    expect(archived.json().archivedAt).toEqual(expect.any(String))
    expect((await app.inject({ method: "GET", url: "/ai-chat" })).json().chats).toEqual([])
  })

  it("counts the chat in the shared monthly budget", async () => {
    state.research.chatSpend = { totalUsd: 20, count: 4 }
    const app = await buildApp("creator")
    const response = await app.inject({ method: "POST", url: "/ai-chat", payload: { question: "hola" } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: "budget_exhausted", message: "The monthly spending limit has been reached" })
  })

  it.each([
    [{ question: "" }, 400, "invalid_question"],
    [{}, 400, "invalid_question"],
    [{ question: "a".repeat(4001) }, 400, "invalid_question"],
  ])("rejects the question %j", async (payload, status, error) => {
    const app = await buildApp("admin")
    const response = await app.inject({ method: "POST", url: "/ai-chat", payload })
    expect(response.statusCode).toBe(status)
    expect(response.json().error).toBe(error)
  })

  it("answers research_off without the API key", async () => {
    state.apiKey = ""
    const app = await buildApp("admin")
    const response = await app.inject({ method: "POST", url: "/ai-chat", payload: { question: "hola" } })
    expect(response.statusCode).toBe(503)
    expect(response.json().error).toBe("research_off")
  })

  it("hides another admin's chats", async () => {
    const mine = await buildApp("admin", "santi")
    const { chat } = (await mine.inject({ method: "POST", url: "/ai-chat", payload: { question: "hola" } })).json()
    const theirs = await buildApp("admin", "diego")
    expect((await theirs.inject({ method: "GET", url: `/ai-chat/${chat.id}` })).statusCode).toBe(404)
    expect((await theirs.inject({ method: "POST", url: `/ai-chat/${chat.id}/archive` })).statusCode).toBe(404)
    expect((await theirs.inject({ method: "GET", url: "/ai-chat" })).json().chats).toEqual([])
  })

  it.each([
    ["GET", "/ai-chat"],
    ["POST", "/ai-chat"],
    ["GET", "/ai-chat/x"],
    ["GET", "/ai-chat/messages/x"],
    ["POST", "/ai-chat/x/messages"],
    ["POST", "/ai-chat/x/archive"],
  ] as const)("refuses %s %s to members", async (method, url) => {
    const app = await buildApp("member")
    const response = await app.inject(method === "POST" ? { method, url, payload: { question: "hola" } } : { method, url })
    expect(response.statusCode).toBe(403)
    expect(state.chats.chats).toHaveLength(0)
  })
})
