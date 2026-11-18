import Anthropic from "@anthropic-ai/sdk"
import type { IChatAssistant } from "@ports/interfaces.js"
import { usageOf } from "@infrastructure/anthropic/ClaudeWebResearcher.js"
import { AssistantError, CHAT_SYSTEM_PROMPT, CHAT_TOOLS, type ChatAnswer, type ChatTurn } from "@domain/aiChat.js"
import { EMPTY_USAGE, addUsage, sourcesFromBlocks, summaryFromBlocks } from "@domain/webResearch.js"

export const CHAT_MODEL = "claude-opus-5-5"
export const CHAT_CALL_TIMEOUT_MS = 180_000

const MAX_TOKENS = 16_000

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  ...CHAT_TOOLS,
  { type: "web_search_20260209", name: "web_search" },
  { type: "web_fetch_20260209", name: "web_fetch" },
]

type MessageParam = Anthropic.Beta.BetaMessageParam
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam

function withCacheBreakpoint(messages: readonly MessageParam[]): MessageParam[] {
  const last = messages[messages.length - 1]
  if (!last) return []
  const content: ContentBlockParam[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content]
  const tail = content[content.length - 1]
  if (tail && "type" in tail && tail.type !== "thinking" && tail.type !== "redacted_thinking") {
    content[content.length - 1] = { ...tail, cache_control: { type: "ephemeral" } } as ContentBlockParam
  }
  return [...messages.slice(0, -1), { role: last.role, content }]
}

export class ClaudeChatAssistant implements IChatAssistant {
  constructor(
    private readonly client: Anthropic,
    private readonly callTimeoutMs: number = CHAT_CALL_TIMEOUT_MS
  ) {}

  static withApiKey(apiKey: string): ClaudeChatAssistant {
    return new ClaudeChatAssistant(new Anthropic({ apiKey, timeout: CHAT_CALL_TIMEOUT_MS, maxRetries: 2 }))
  }

  async answer(turn: ChatTurn): Promise<ChatAnswer> {
    const messages: MessageParam[] = [
      ...turn.history.map((entry): MessageParam => ({ role: entry.role, content: entry.text })),
      { role: "user", content: turn.question },
    ]
    const blocks: Anthropic.Beta.BetaContentBlock[] = []
    let usage = EMPTY_USAGE
    let model = CHAT_MODEL

    for (;;) {
      let message: Anthropic.Beta.BetaMessage
      try {
        message = await this.client.beta.messages.create(
          {
            model: CHAT_MODEL,
            max_tokens: MAX_TOKENS,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            system: [{ type: "text", text: CHAT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            tools: TOOLS,
            messages: withCacheBreakpoint(messages),
          },
          { signal: AbortSignal.timeout(this.callTimeoutMs) }
        )
      } catch (err) {
        throw new AssistantError(err instanceof Error ? err.message : String(err), usage, model)
      }

      usage = addUsage(usage, usageOf(message))
      model = message.model
      blocks.push(...message.content)

      if (message.stop_reason === "end_turn") {
        return { text: summaryFromBlocks(blocks), sources: sourcesFromBlocks(blocks), model, usage, stoppedForBudget: false }
      }
      if (message.stop_reason === "refusal") {
        throw new AssistantError("Claude declined to answer", usage, model)
      }
      if (message.stop_reason !== "pause_turn" && message.stop_reason !== "tool_use") {
        throw new AssistantError(`The answer stopped early: ${message.stop_reason}`, usage, model)
      }

      messages.push({ role: "assistant", content: message.content as ContentBlockParam[] })
      if (message.stop_reason === "tool_use") {
        const results: ContentBlockParam[] = []
        for (const block of message.content) {
          if (block.type !== "tool_use") continue
          const outcome = await turn.executeTool(block.name, block.input)
          results.push({ type: "tool_result", tool_use_id: block.id, content: outcome.content, is_error: outcome.isError })
        }
        messages.push({ role: "user", content: results })
      }

      if (!(await turn.afterRound(usage, model))) {
        return { text: summaryFromBlocks(blocks), sources: sourcesFromBlocks(blocks), model, usage, stoppedForBudget: true }
      }
    }
  }
}
