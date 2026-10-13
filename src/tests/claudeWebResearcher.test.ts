import { describe, it, expect } from "vitest"
import type Anthropic from "@anthropic-ai/sdk"
import { ClaudeWebResearcher, usageOf } from "@infrastructure/anthropic/ClaudeWebResearcher"
import { ResearcherError } from "@domain/webResearch"

type Message = Anthropic.Beta.BetaMessage

function message(overrides: Record<string, unknown> = {}, usage: Record<string, unknown> = {}): Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    content: [],
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 5,
      server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
      iterations: null,
      ...usage,
    },
    ...overrides,
  } as unknown as Message
}

function fakeClient(replies: (Message | Error)[]) {
  const calls: { params: Anthropic.Beta.MessageCreateParamsNonStreaming; options: { signal?: AbortSignal } }[] = []
  const client = {
    beta: {
      messages: {
        create: async (params: Anthropic.Beta.MessageCreateParamsNonStreaming, options: { signal?: AbortSignal }) => {
          calls.push({ params: { ...params, messages: [...params.messages] }, options })
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

const SUBJECT = { businessName: "ACME SA", taxId: "30712345678" }

async function failure(promise: Promise<unknown>): Promise<ResearcherError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ResearcherError) return err
    throw err
  }
  throw new Error("expected a failure")
}

describe("ClaudeWebResearcher", () => {
  it("asks Opus 5.5 with web search, web fetch and default fallbacks, sending only name and CUIT", async () => {
    const { client, calls } = fakeClient([
      message({
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "ACME SA" } },
          {
            type: "text",
            text: "ACME SA es una constructora.",
            citations: [{ type: "web_search_result_location", url: "https://a.com", title: "A", cited_text: "x", encrypted_index: "e" }],
          },
        ],
      }),
    ])

    const findings = await new ClaudeWebResearcher(client).research(SUBJECT)

    const params = calls[0]!.params
    expect(params.model).toBe("claude-opus-5-5")
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"])
    expect(params.fallbacks).toBe("default")
    expect(params.tools).toEqual([
      { type: "web_search_20260209", name: "web_search", max_uses: 8 },
      { type: "web_fetch_20260209", name: "web_fetch" },
    ])
    expect(params.messages).toEqual([{ role: "user", content: 'Investigá a "ACME SA", CUIT 30712345678.' }])
    expect(calls[0]!.options.signal).toBeInstanceOf(AbortSignal)
    expect(findings).toEqual({
      summary: "ACME SA es una constructora.",
      sources: [{ url: "https://a.com", title: "A" }],
      model: "claude-opus-5-5",
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, webSearches: 2 },
    })
  })

  it("resumes a paused turn and adds up the usage", async () => {
    const paused = message({
      stop_reason: "pause_turn",
      content: [{ type: "text", text: "Primera parte. ", citations: null }],
    })
    const { client, calls } = fakeClient([
      paused,
      message({ content: [{ type: "text", text: "Segunda parte.", citations: null }] }),
    ])

    const findings = await new ClaudeWebResearcher(client).research(SUBJECT)

    expect(calls).toHaveLength(2)
    expect(calls[1]!.params.messages[1]).toEqual({ role: "assistant", content: paused.content })
    expect(findings.summary).toBe("Primera parte. Segunda parte.")
    expect(findings.usage).toEqual({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 10, webSearches: 4 })
  })

  it("fails on a refusal, keeping the usage", async () => {
    const { client } = fakeClient([message({ stop_reason: "refusal" })])
    const error = await failure(new ClaudeWebResearcher(client).research(SUBJECT))
    expect(error.message).toBe("Claude declined the research")
    expect(error.usage.inputTokens).toBe(100)
  })

  it("fails when the answer is cut off", async () => {
    const { client } = fakeClient([message({ stop_reason: "max_tokens" })])
    expect((await failure(new ClaudeWebResearcher(client).research(SUBJECT))).message).toBe(
      "The research stopped early: max_tokens"
    )
  })

  it("gives up after too many pauses", async () => {
    const { client, calls } = fakeClient(Array.from({ length: 6 }, () => message({ stop_reason: "pause_turn" })))
    const error = await failure(new ClaudeWebResearcher(client).research(SUBJECT))
    expect(error.message).toBe("The research kept pausing and never finished")
    expect(calls).toHaveLength(6)
    expect(error.usage.webSearches).toBe(12)
  })

  it("wraps an API error with the usage spent so far", async () => {
    const { client } = fakeClient([message({ stop_reason: "pause_turn" }), new Error("overloaded")])
    const error = await failure(new ClaudeWebResearcher(client).research(SUBJECT))
    expect(error.message).toBe("overloaded")
    expect(error.usage.outputTokens).toBe(10)
  })

  it("wraps a thrown non-error", async () => {
    const client = { beta: { messages: { create: async () => Promise.reject("boom") } } } as unknown as Anthropic
    expect((await failure(new ClaudeWebResearcher(client).research(SUBJECT))).message).toBe("boom")
  })

  it("builds a client from an API key without calling it", () => {
    expect(ClaudeWebResearcher.withApiKey("test-key")).toBeInstanceOf(ClaudeWebResearcher)
  })
})

describe("usageOf", () => {
  it("sums every attempt when the response lists them", () => {
    const usage = usageOf(
      message({}, {
        iterations: [
          { type: "message", input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0 },
          { type: "fallback_message", input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 3 },
        ],
      })
    )
    expect(usage).toEqual({ inputTokens: 200, outputTokens: 10, cacheReadTokens: 3, webSearches: 2 })
  })

  it("reads missing cache and server tool counts as zero", () => {
    expect(usageOf(message({}, { cache_read_input_tokens: null, server_tool_use: null }))).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      webSearches: 0,
    })
  })
})
