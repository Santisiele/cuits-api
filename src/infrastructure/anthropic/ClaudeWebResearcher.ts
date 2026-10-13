import Anthropic from "@anthropic-ai/sdk"
import type { IWebResearcher } from "@ports/interfaces.js"
import {
  CLAUDE_RESEARCH_PRICES_USD,
  EMPTY_USAGE,
  ResearcherError,
  addUsage,
  buildResearchRequest,
  sourcesFromBlocks,
  summaryFromBlocks,
  type ResearchFindings,
  type ResearchSubject,
  type ResearchUsage,
} from "@domain/webResearch.js"

export const RESEARCH_MODEL = "claude-opus-5-5"
export const RESEARCH_TIMEOUT_MS = 180_000

const MAX_TOKENS = 16_000
const MAX_CONTINUATIONS = 5

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 8 },
  { type: "web_fetch_20260209", name: "web_fetch" },
]

export function usageOf(message: Anthropic.Beta.BetaMessage): ResearchUsage {
  const { usage } = message
  const attempts = usage.iterations?.length ? usage.iterations : [usage]
  return attempts.reduce<ResearchUsage>(
    (total, attempt) =>
      addUsage(total, {
        inputTokens: attempt.input_tokens,
        outputTokens: attempt.output_tokens,
        cacheReadTokens: attempt.cache_read_input_tokens ?? 0,
        webSearches: 0,
      }),
    { ...EMPTY_USAGE, webSearches: usage.server_tool_use?.web_search_requests ?? 0 }
  )
}

export class ClaudeWebResearcher implements IWebResearcher {
  readonly prices = CLAUDE_RESEARCH_PRICES_USD

  constructor(
    private readonly client: Anthropic,
    private readonly timeoutMs: number = RESEARCH_TIMEOUT_MS
  ) {}

  static withApiKey(apiKey: string): ClaudeWebResearcher {
    return new ClaudeWebResearcher(new Anthropic({ apiKey, timeout: RESEARCH_TIMEOUT_MS }))
  }

  async research(subject: ResearchSubject): Promise<ResearchFindings> {
    const request = buildResearchRequest(subject)
    const signal = AbortSignal.timeout(this.timeoutMs)
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: request.userMessage }]
    const blocks: Anthropic.Beta.BetaContentBlock[] = []
    let usage = EMPTY_USAGE
    let model = RESEARCH_MODEL

    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
      let message: Anthropic.Beta.BetaMessage
      try {
        message = await this.client.beta.messages.create(
          {
            model: RESEARCH_MODEL,
            max_tokens: MAX_TOKENS,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            system: request.system,
            tools: TOOLS,
            messages,
          },
          { signal }
        )
      } catch (err) {
        throw new ResearcherError(err instanceof Error ? err.message : String(err), usage, model)
      }

      usage = addUsage(usage, usageOf(message))
      model = message.model
      blocks.push(...message.content)

      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content })
        continue
      }
      if (message.stop_reason === "refusal") {
        throw new ResearcherError("Claude declined the research", usage, model)
      }
      if (message.stop_reason !== "end_turn") {
        throw new ResearcherError(`The research stopped early: ${message.stop_reason}`, usage, model)
      }
      return { summary: summaryFromBlocks(blocks), sources: sourcesFromBlocks(blocks), model, usage }
    }

    throw new ResearcherError("The research kept pausing and never finished", usage, model)
  }
}
