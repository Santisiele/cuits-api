import { describe, it, expect } from "vitest"
import {
  EMPTY_USAGE,
  ResearcherError,
  CLAUDE_RESEARCH_PRICES_USD,
  GEMINI_RESEARCH_PRICES_USD,
  chooseResearchProvider,
  addUsage,
  buildResearchRequest,
  costFromUsage,
  isBudgetExhausted,
  isValidMonthlyLimit,
  isValidResearchCuit,
  roundUsd,
  sourcesFromBlocks,
  startOfMonthInBuenosAires,
  summaryFromBlocks,
} from "@domain/webResearch"

describe("web research cost", () => {
  it("prices each part of the usage at list price", () => {
    expect(costFromUsage({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 }, CLAUDE_RESEARCH_PRICES_USD)).toBe(4)
    expect(costFromUsage({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, webSearches: 0 }, CLAUDE_RESEARCH_PRICES_USD)).toBe(20)
    expect(costFromUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, webSearches: 0 }, CLAUDE_RESEARCH_PRICES_USD)).toBe(0.2)
    expect(costFromUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 1000 }, CLAUDE_RESEARCH_PRICES_USD)).toBe(10)
  })

  it("adds the parts together", () => {
    expect(costFromUsage({ inputTokens: 50_000, outputTokens: 4_000, cacheReadTokens: 10_000, webSearches: 6 }, CLAUDE_RESEARCH_PRICES_USD)).toBe(0.342)
  })

  it("costs nothing without usage", () => {
    expect(costFromUsage(EMPTY_USAGE, CLAUDE_RESEARCH_PRICES_USD)).toBe(0)
  })

  it("prices Gemini with its own table", () => {
    expect(costFromUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, webSearches: 1000 }, GEMINI_RESEARCH_PRICES_USD)).toBe(18.575)
  })

  it("keeps the Claude prices in one constant", () => {
    expect(CLAUDE_RESEARCH_PRICES_USD).toEqual({
      inputPerMillionTokens: 4,
      outputPerMillionTokens: 20,
      cacheReadPerMillionTokens: 0.2,
      perThousandWebSearches: 10,
    })
  })

  it("rounds to a millionth of a dollar", () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3)
    expect(roundUsd(0.0000004)).toBe(0)
  })

  it("adds usages field by field", () => {
    expect(
      addUsage(
        { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, webSearches: 4 },
        { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, webSearches: 40 }
      )
    ).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, webSearches: 44 })
  })
})

describe("start of the month in Buenos Aires", () => {
  it("is midnight of the first in Buenos Aires, 03:00 UTC", () => {
    expect(startOfMonthInBuenosAires(new Date("2026-10-13T15:00:00Z"))).toBe("2026-10-01T03:00:00.000Z")
  })

  it("still belongs to the previous month before 03:00 UTC on the first", () => {
    expect(startOfMonthInBuenosAires(new Date("2026-11-01T02:59:59Z"))).toBe("2026-10-01T03:00:00.000Z")
  })

  it("starts the new month at 03:00 UTC on the first", () => {
    expect(startOfMonthInBuenosAires(new Date("2026-11-01T03:00:00Z"))).toBe("2026-11-01T03:00:00.000Z")
  })

  it("rolls back across the year", () => {
    expect(startOfMonthInBuenosAires(new Date("2027-01-01T01:00:00Z"))).toBe("2026-12-01T03:00:00.000Z")
  })
})

describe("budget", () => {
  it("is exhausted once the spend reaches the limit", () => {
    expect(isBudgetExhausted(19.99, 20)).toBe(false)
    expect(isBudgetExhausted(20, 20)).toBe(true)
    expect(isBudgetExhausted(25, 20)).toBe(true)
  })

  it("is exhausted from the start with a limit of zero", () => {
    expect(isBudgetExhausted(0, 0)).toBe(true)
  })

  it("accepts finite numbers from zero up as a limit", () => {
    expect(isValidMonthlyLimit(0)).toBe(true)
    expect(isValidMonthlyLimit(12.5)).toBe(true)
    expect(isValidMonthlyLimit(-1)).toBe(false)
    expect(isValidMonthlyLimit(Number.NaN)).toBe(false)
    expect(isValidMonthlyLimit(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isValidMonthlyLimit("20")).toBe(false)
    expect(isValidMonthlyLimit(undefined)).toBe(false)
  })
})

describe("CUIT validation", () => {
  it("takes eleven digits without dashes", () => {
    expect(isValidResearchCuit("30712345678")).toBe(true)
    expect(isValidResearchCuit("30-71234567-8")).toBe(false)
    expect(isValidResearchCuit("3071234567")).toBe(false)
    expect(isValidResearchCuit("3071234567a")).toBe(false)
  })
})

describe("the request to Claude", () => {
  it("carries the name and the CUIT and nothing else", () => {
    const subject = { businessName: "ACME SA", taxId: "30712345678", debt: 1_000_000, situation: 5, sources: ["Bolsa"] }
    const request = buildResearchRequest(subject)

    expect(request.userMessage).toBe('Investigá a "ACME SA", CUIT 30712345678.')
    const everything = request.system + request.userMessage
    expect(everything).not.toContain("1000000")
    expect(everything).not.toContain("Bolsa")
  })

  it("names no one when the base has no name", () => {
    expect(buildResearchRequest({ businessName: "  ", taxId: "30712345678" }).userMessage).toBe(
      "Investigá a la entidad, CUIT 30712345678."
    )
  })

  it("asks for public commercial information in Spanish with sources", () => {
    const { system } = buildResearchRequest({ businessName: "ACME SA", taxId: "30712345678" })
    expect(system).toContain("español")
    expect(system).toContain("vida personal")
    expect(system).toContain("fuente")
    expect(system).toContain("homónimos")
    expect(system).toContain("no encontrás nada relevante")
  })
})

describe("reading the answer", () => {
  const blocks = [
    { type: "server_tool_use" },
    { type: "text", text: "ACME SA es una constructora ", citations: null },
    {
      type: "text",
      text: "constituida en 2010.",
      citations: [
        { type: "web_search_result_location", url: "https://boletin.gob.ar/1", title: "Boletín Oficial" },
        { type: "web_search_result_location", url: "https://boletin.gob.ar/1", title: "Repetida" },
        { type: "web_search_result_location", url: "https://diario.com/nota", title: null },
        { type: "char_location" },
      ],
    },
    { type: "text", text: " Sin concursos.\n" },
    { type: "text" },
  ]

  it("joins the text blocks into the summary", () => {
    expect(summaryFromBlocks(blocks)).toBe("ACME SA es una constructora constituida en 2010. Sin concursos.")
  })

  it("takes deduplicated sources from the web search citations", () => {
    expect(sourcesFromBlocks(blocks)).toEqual([
      { url: "https://boletin.gob.ar/1", title: "Boletín Oficial" },
      { url: "https://diario.com/nota", title: "https://diario.com/nota" },
    ])
  })

  it("has no sources without citations", () => {
    expect(sourcesFromBlocks([{ type: "text", text: "Nada" }])).toEqual([])
  })
})

describe("researcher error", () => {
  it("keeps the usage it spent", () => {
    const error = new ResearcherError("refused", { ...EMPTY_USAGE, webSearches: 2 }, "claude-opus-5-5")
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("ResearcherError")
    expect(error.usage.webSearches).toBe(2)
    expect(error.model).toBe("claude-opus-5-5")
  })
})

describe("chooseResearchProvider", () => {
  const both = { claudeApiKey: "sk-ant", geminiApiKey: "AIza" }

  it("uses the provider asked for when its key is there", () => {
    expect(chooseResearchProvider({ ...both, provider: "claude" })).toBe("claude")
    expect(chooseResearchProvider({ ...both, provider: " Gemini " })).toBe("gemini")
  })

  it("turns research off when the provider asked for has no key", () => {
    expect(chooseResearchProvider({ provider: "claude", claudeApiKey: "", geminiApiKey: "AIza" })).toBeNull()
  })

  it("prefers Gemini when no provider is set", () => {
    expect(chooseResearchProvider({ ...both, provider: "" })).toBe("gemini")
    expect(chooseResearchProvider({ provider: "", claudeApiKey: "sk-ant", geminiApiKey: "" })).toBe("claude")
  })

  it("ignores an unknown provider name and falls back to the keys", () => {
    expect(chooseResearchProvider({ ...both, provider: "openai" })).toBe("gemini")
  })

  it("turns research off without any key", () => {
    expect(chooseResearchProvider({ provider: "", claudeApiKey: "", geminiApiKey: "" })).toBeNull()
  })
})
