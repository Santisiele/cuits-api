import { describe, it, expect } from "vitest"
import type Anthropic from "@anthropic-ai/sdk"
import { ClaudeChatAssistant } from "@infrastructure/anthropic/ClaudeChatAssistant"
import { AssistantError, CHAT_SYSTEM_PROMPT, type ChatTurn, type ToolOutcome } from "@domain/aiChat"

type Message = Anthropic.Beta.BetaMessage
type Params = Anthropic.Beta.MessageCreateParamsNonStreaming

function message(stop_reason: string, content: unknown[], usage: Record<string, unknown> = {}): Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason,
    content,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, server_tool_use: null, iterations: null, ...usage },
  } as unknown as Message
}

function fakeClient(replies: (Message | Error)[]) {
  const calls: Params[] = []
  const client = {
    beta: {
      messages: {
        create: async (params: Params) => {
          calls.push(structuredClone(params))
          const reply = replies.shift()
          if (!reply) throw new Error("no reply left")
          if (reply instanceof Error) throw reply
          return reply
        },
      },
    },
  } as unknown as Anthropic
  return { client, calls }
}

function turn(overrides: Partial<ChatTurn> = {}) {
  const tools: { name: string; input: unknown }[] = []
  const rounds: number[] = []
  const value: ChatTurn = {
    history: [],
    question: "¿Cuántos CUITs hay?",
    executeTool: async (name, input): Promise<ToolOutcome> => {
      tools.push({ name, input })
      return { content: '{"resultId":"r1","rows":[[56000]]}', isError: false }
    },
    afterRound: async (usage) => {
      rounds.push(usage.inputTokens)
      return true
    },
    ...overrides,
  }
  return { value, tools, rounds }
}

describe("ClaudeChatAssistant", () => {
  it("runs the client tools and sends their results back until Claude ends", async () => {
    const { client, calls } = fakeClient([
      message("tool_use", [
        { type: "text", text: "Consulto." },
        { type: "tool_use", id: "t1", name: "run_query", input: { cypher: "MATCH (c:CUIT) RETURN count(c)" } },
      ]),
      message("end_turn", [{ type: "text", text: "Hay **56.000** CUITs." }], { server_tool_use: { web_search_requests: 1 } }),
    ])
    const { value, tools, rounds } = turn({ history: [{ role: "user", text: "hola" }, { role: "assistant", text: "¿Qué necesitás?" }] })

    const answer = await new ClaudeChatAssistant(client).answer(value)

    expect(answer).toEqual({
      text: "Hay **56.000** CUITs.",
      sources: [],
      model: "claude-opus-5-5",
      usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, webSearches: 1 },
      stoppedForBudget: false,
    })
    expect(tools).toEqual([{ name: "run_query", input: { cypher: "MATCH (c:CUIT) RETURN count(c)" } }])
    expect(rounds).toEqual([100])

    const first = calls[0]
    expect(first?.model).toBe("claude-opus-5-5")
    expect(first?.system).toEqual([{ type: "text", text: CHAT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }])
    const sentTools = (first?.tools ?? []) as { name: string }[]
    expect(sentTools.map((tool) => tool.name)).toEqual(["run_query", "show_table", "get_table", "web_search", "web_fetch"])
    expect(sentTools.find((tool) => tool.name === "web_search")).not.toHaveProperty("max_uses")
    expect(first?.messages).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "¿Qué necesitás?" },
      { role: "user", content: [{ type: "text", text: "¿Cuántos CUITs hay?", cache_control: { type: "ephemeral" } }] },
    ])

    const second = calls[1]?.messages ?? []
    expect(second[3]?.role).toBe("assistant")
    expect(second[4]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: '{"resultId":"r1","rows":[[56000]]}',
          is_error: false,
          cache_control: { type: "ephemeral" },
        },
      ],
    })
    expect(second[2]).toEqual({ role: "user", content: "¿Cuántos CUITs hay?" })
  })

  it("continues a paused turn without running tools", async () => {
    const { client, calls } = fakeClient([
      message("pause_turn", [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "ACME" } }]),
      message("end_turn", [{ type: "text", text: "Listo." }]),
    ])
    const { value, tools } = turn()
    expect((await new ClaudeChatAssistant(client).answer(value)).text).toBe("Listo.")
    expect(tools).toEqual([])
    expect(calls[1]?.messages).toHaveLength(2)
  })

  it("stops with what it has when the budget runs out between rounds", async () => {
    const { client, calls } = fakeClient([
      message("tool_use", [
        { type: "text", text: "Busco." },
        { type: "tool_use", id: "t1", name: "run_query", input: {} },
      ]),
    ])
    const { value } = turn({ afterRound: async () => false })
    const answer = await new ClaudeChatAssistant(client).answer(value)
    expect(answer.stoppedForBudget).toBe(true)
    expect(answer.usage.inputTokens).toBe(100)
    expect(calls).toHaveLength(1)
  })

  it("fails with the usage so far on errors, refusals and early stops", async () => {
    const cases: [Message | Error, string][] = [
      [new Error("overloaded"), "overloaded"],
      [message("refusal", []), "Claude declined to answer"],
      [message("max_tokens", [{ type: "text", text: "a medias" }]), "The answer stopped early: max_tokens"],
    ]
    for (const [reply, expected] of cases) {
      const { client } = fakeClient([message("tool_use", [{ type: "tool_use", id: "t1", name: "run_query", input: {} }]), reply])
      const error = await new ClaudeChatAssistant(client).answer(turn().value).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(AssistantError)
      expect((error as AssistantError).message).toBe(expected)
      expect((error as AssistantError).usage.inputTokens).toBe(reply instanceof Error ? 100 : 200)
    }
  })
})
