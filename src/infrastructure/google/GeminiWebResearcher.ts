import { GoogleGenAI, type GenerateContentResponse } from "@google/genai"
import type { IWebResearcher } from "@ports/interfaces.js"
import {
  EMPTY_USAGE,
  GEMINI_RESEARCH_PRICES_USD,
  ResearcherError,
  buildResearchRequest,
  type ResearchFindings,
  type ResearchSource,
  type ResearchSubject,
  type ResearchUsage,
} from "@domain/webResearch.js"

export const GEMINI_RESEARCH_MODEL = "gemini-3.8-flash"
export const GEMINI_RESEARCH_TIMEOUT_MS = 180_000

export function geminiUsage(response: GenerateContentResponse): ResearchUsage {
  const usage = response.usageMetadata
  const queries = response.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? []
  return {
    inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
    webSearches: queries.length,
  }
}

export function geminiSources(response: GenerateContentResponse): ResearchSource[] {
  const byUrl = new Map<string, ResearchSource>()
  for (const chunk of response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
    const url = chunk.web?.uri
    if (!url || byUrl.has(url)) continue
    byUrl.set(url, { url, title: chunk.web?.title || url })
  }
  return [...byUrl.values()]
}

export function geminiFindings(response: GenerateContentResponse, model: string): ResearchFindings {
  const usage = geminiUsage(response)
  const reason = response.candidates?.[0]?.finishReason
  if (reason !== "STOP") {
    throw new ResearcherError(`The research stopped early: ${reason ?? "no answer"}`, usage, model)
  }
  const summary = (response.text ?? "").trim()
  if (summary === "") {
    throw new ResearcherError("The research came back empty", usage, model)
  }
  return { summary, sources: geminiSources(response), model, usage }
}

export class GeminiWebResearcher implements IWebResearcher {
  readonly prices = GEMINI_RESEARCH_PRICES_USD

  constructor(
    private readonly client: GoogleGenAI,
    private readonly timeoutMs: number = GEMINI_RESEARCH_TIMEOUT_MS
  ) {}

  static withApiKey(apiKey: string): GeminiWebResearcher {
    return new GeminiWebResearcher(new GoogleGenAI({ apiKey }))
  }

  async research(subject: ResearchSubject): Promise<ResearchFindings> {
    const request = buildResearchRequest(subject)
    let response: GenerateContentResponse
    try {
      response = await this.client.models.generateContent({
        model: GEMINI_RESEARCH_MODEL,
        contents: request.userMessage,
        config: {
          systemInstruction: request.system,
          tools: [{ googleSearch: {} }],
          abortSignal: AbortSignal.timeout(this.timeoutMs),
        },
      })
    } catch (err) {
      throw new ResearcherError(err instanceof Error ? err.message : String(err), EMPTY_USAGE, GEMINI_RESEARCH_MODEL)
    }
    return geminiFindings(response, response.modelVersion || GEMINI_RESEARCH_MODEL)
  }
}
