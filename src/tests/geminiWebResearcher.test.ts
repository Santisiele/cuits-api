import { describe, it, expect } from "vitest"
import type { GenerateContentParameters, GenerateContentResponse, GoogleGenAI } from "@google/genai"
import {
  GEMINI_RESEARCH_MODEL,
  GeminiWebResearcher,
  geminiFindings,
  geminiSources,
  geminiUsage,
} from "@infrastructure/google/GeminiWebResearcher"
import { GEMINI_RESEARCH_PRICES_USD, ResearcherError } from "@domain/webResearch"

function response(overrides: Record<string, unknown> = {}, candidate: Record<string, unknown> = {}): GenerateContentResponse {
  return {
    text: "ACME SA es una constructora de Córdoba.",
    modelVersion: "gemini-3.8-flash-001",
    usageMetadata: {
      promptTokenCount: 120,
      toolUsePromptTokenCount: 3000,
      candidatesTokenCount: 400,
      thoughtsTokenCount: 600,
      cachedContentTokenCount: 50,
    },
    candidates: [
      {
        finishReason: "STOP",
        groundingMetadata: {
          webSearchQueries: ["ACME SA CUIT 30500010912", "ACME SA boletín oficial"],
          groundingChunks: [
            { web: { uri: "https://boletin.gob.ar/1", title: "boletin.gob.ar" } },
            { web: { uri: "https://boletin.gob.ar/1", title: "boletin.gob.ar" } },
            { web: { uri: "https://diario.com/nota" } },
            { retrievedContext: { uri: "ignored" } },
          ],
        },
        ...candidate,
      },
    ],
    ...overrides,
  } as unknown as GenerateContentResponse
}

function fakeClient(reply: GenerateContentResponse | Error) {
  const calls: GenerateContentParameters[] = []
  const client = {
    models: {
      generateContent: async (params: GenerateContentParameters) => {
        calls.push(params)
        if (reply instanceof Error) throw reply
        return reply
      },
    },
  } as unknown as GoogleGenAI
  return { client, calls }
}

describe("geminiUsage", () => {
  it("counts the search results as input and the thinking as output", () => {
    expect(geminiUsage(response())).toEqual({ inputTokens: 3120, outputTokens: 1000, cacheReadTokens: 50, webSearches: 2 })
  })

  it("reads missing usage as zero", () => {
    expect(geminiUsage(response({ usageMetadata: undefined, candidates: [] }))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      webSearches: 0,
    })
  })
})

describe("geminiSources", () => {
  it("keeps each web page once and falls back to the url as title", () => {
    expect(geminiSources(response())).toEqual([
      { url: "https://boletin.gob.ar/1", title: "boletin.gob.ar" },
      { url: "https://diario.com/nota", title: "https://diario.com/nota" },
    ])
  })

  it("returns nothing without grounding", () => {
    expect(geminiSources(response({}, { groundingMetadata: undefined }))).toEqual([])
  })
})

describe("geminiFindings", () => {
  it("returns the summary, the sources, the model and the usage", () => {
    const findings = geminiFindings(response(), "gemini-3.8-flash-001")
    expect(findings.summary).toBe("ACME SA es una constructora de Córdoba.")
    expect(findings.sources).toHaveLength(2)
    expect(findings.model).toBe("gemini-3.8-flash-001")
    expect(findings.usage.webSearches).toBe(2)
  })

  it("fails when the answer was cut, keeping the usage spent", () => {
    const error = (() => {
      try {
        geminiFindings(response({}, { finishReason: "SAFETY" }), "m")
      } catch (err) {
        return err
      }
    })()
    expect(error).toBeInstanceOf(ResearcherError)
    expect((error as ResearcherError).message).toContain("SAFETY")
    expect((error as ResearcherError).usage.inputTokens).toBe(3120)
  })

  it("fails when there is no candidate", () => {
    expect(() => geminiFindings(response({ candidates: [] }), "m")).toThrow("no answer")
  })

  it("fails when the answer is empty", () => {
    expect(() => geminiFindings(response({ text: "  " }), "m")).toThrow("came back empty")
  })

  it("fails when there is no text at all", () => {
    expect(() => geminiFindings(response({ text: undefined }), "m")).toThrow("came back empty")
  })
})

describe("GeminiWebResearcher", () => {
  it("prices with the Gemini table", () => {
    expect(new GeminiWebResearcher(fakeClient(response()).client).prices).toBe(GEMINI_RESEARCH_PRICES_USD)
  })

  it("sends only the name and CUIT, with Google Search and a timeout", async () => {
    const { client, calls } = fakeClient(response())
    await new GeminiWebResearcher(client, 1000).research({ businessName: "ACME SA", taxId: "30500010912" })

    expect(calls).toHaveLength(1)
    const params = calls[0]!
    expect(params.model).toBe(GEMINI_RESEARCH_MODEL)
    expect(params.contents).toBe('Investigá a "ACME SA", CUIT 30500010912.')
    expect(params.config?.tools).toEqual([{ googleSearch: {} }])
    expect(typeof params.config?.systemInstruction).toBe("string")
    expect(params.config?.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it("reports the model version Google answered with", async () => {
    const findings = await new GeminiWebResearcher(fakeClient(response()).client).research({ businessName: "ACME SA", taxId: "30500010912" })
    expect(findings.model).toBe("gemini-3.8-flash-001")
  })

  it("falls back to the requested model name", async () => {
    const findings = await new GeminiWebResearcher(fakeClient(response({ modelVersion: undefined })).client).research({
      businessName: "ACME SA",
      taxId: "30500010912",
    })
    expect(findings.model).toBe(GEMINI_RESEARCH_MODEL)
  })

  it("turns a failed call into a researcher error with no usage", async () => {
    const researcher = new GeminiWebResearcher(fakeClient(new Error("quota exceeded")).client)
    const error = await researcher.research({ businessName: "ACME SA", taxId: "30500010912" }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ResearcherError)
    expect((error as ResearcherError).message).toBe("quota exceeded")
    expect((error as ResearcherError).usage.inputTokens).toBe(0)
  })

  it("keeps a non-Error failure readable", async () => {
    const { client } = fakeClient(response())
    ;(client.models as unknown as { generateContent: () => Promise<never> }).generateContent = async () => {
      throw "boom"
    }
    const error = await new GeminiWebResearcher(client).research({ businessName: "A", taxId: "30500010912" }).catch((e: unknown) => e)
    expect((error as ResearcherError).message).toBe("boom")
  })

  it("builds a real client from an api key", () => {
    expect(GeminiWebResearcher.withApiKey("AIza-test")).toBeInstanceOf(GeminiWebResearcher)
  })
})
