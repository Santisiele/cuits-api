import { describe, it, expect, beforeEach } from "vitest"
import { WebResearchService, WebResearchError } from "@application/WebResearchService"
import { ResearcherError } from "@domain/webResearch"
import { FakeResearcher, InMemoryWebResearchRepository, storedResearch } from "./webResearchFakes"

const NOW = new Date("2026-10-13T15:00:00.000Z")
const TAX_ID = "30712345678"

let repository: InMemoryWebResearchRepository
let researcher: FakeResearcher
let service: WebResearchService

function build(withResearcher = true): WebResearchService {
  let next = 0
  return new WebResearchService(repository, withResearcher ? researcher : null, () => NOW, () => `id-${++next}`)
}

async function rejection(promise: Promise<unknown>): Promise<WebResearchError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof WebResearchError) return err
    throw err
  }
  throw new Error("expected a rejection")
}

describe("WebResearchService.research", () => {
  beforeEach(() => {
    repository = new InMemoryWebResearchRepository()
    repository.subjects.set(TAX_ID, { businessName: "ACME SA", inMyBase: true })
    researcher = new FakeResearcher()
    service = build()
  })

  it("sends only the name and the CUIT and stores the result with its cost", async () => {
    const research = await service.research(TAX_ID, "santi")

    expect(researcher.calls).toEqual([{ businessName: "ACME SA", taxId: TAX_ID }])
    expect(research).toEqual({
      id: "id-1",
      taxId: TAX_ID,
      requestedAt: NOW.toISOString(),
      requestedBy: "santi",
      status: "done",
      summary: "ACME SA es una constructora.",
      sources: [{ url: "https://boletin.gob.ar/1", title: "Boletín Oficial" }],
      model: "claude-opus-5-5",
      inputTokens: 50_000,
      outputTokens: 4_000,
      cacheReadTokens: 10_000,
      webSearches: 6,
      costUsd: 0.342,
    })
    expect(repository.saved).toEqual([research])
  })

  it("rejects a malformed CUIT", async () => {
    expect((await rejection(service.research("30-71234567-8", "santi"))).reason).toBe("invalid_cuit")
    expect(researcher.calls).toEqual([])
  })

  it("is off without a researcher", async () => {
    expect((await rejection(build(false).research(TAX_ID, "santi"))).reason).toBe("research_off")
  })

  it("refuses a CUIT that is not in the graph", async () => {
    expect((await rejection(service.research("20111111112", "santi"))).reason).toBe("cuit_not_found")
    expect(researcher.calls).toEqual([])
  })

  it("researches a CUIT that belongs to no source", async () => {
    repository.subjects.set(TAX_ID, { businessName: "ACME SA", inMyBase: false })
    const research = await service.research(TAX_ID, "santi")
    expect(research.status).toBe("done")
    expect(researcher.calls).toEqual([{ businessName: "ACME SA", taxId: TAX_ID }])
  })

  it("does not call Claude once the month's spend reaches the limit", async () => {
    repository.saved.push(storedResearch({ costUsd: 20 }))

    expect((await rejection(service.research(TAX_ID, "santi"))).reason).toBe("budget_exhausted")
    expect(researcher.calls).toEqual([])
  })

  it("ignores last month's spend", async () => {
    repository.saved.push(storedResearch({ costUsd: 50, requestedAt: "2026-10-01T02:59:59.000Z" }))
    await expect(service.research(TAX_ID, "santi")).resolves.toMatchObject({ status: "done" })
  })

  it("stores a failed research with the usage it spent", async () => {
    researcher.failure = new ResearcherError(
      "refused",
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 },
      "claude-opus-5-5"
    )

    const error = await rejection(service.research(TAX_ID, "santi"))

    expect(error.reason).toBe("research_failed")
    expect(error.detail).toBe("refused")
    expect(repository.saved).toHaveLength(1)
    expect(repository.saved[0]).toMatchObject({ status: "failed", summary: "", sources: [], costUsd: 4, model: "claude-opus-5-5" })
    expect(error.research).toEqual(repository.saved[0])
  })

  it("stores a failed research with no cost when nothing is known", async () => {
    researcher.failure = new Error("network down")

    const error = await rejection(service.research(TAX_ID, "santi"))

    expect(error.detail).toBe("network down")
    expect(repository.saved[0]).toMatchObject({ status: "failed", costUsd: 0, model: "", webSearches: 0 })
  })

  it("describes a thrown non-error", async () => {
    researcher.research = async () => {
      throw "boom"
    }
    expect((await rejection(service.research(TAX_ID, "santi"))).detail).toBe("boom")
  })
})

describe("WebResearchService budget and history", () => {
  beforeEach(() => {
    repository = new InMemoryWebResearchRepository()
    researcher = new FakeResearcher()
    service = build()
  })

  it("defaults to 20 USD and sums the month in Buenos Aires", async () => {
    repository.saved.push(
      storedResearch({ id: "a", costUsd: 0.1 }),
      storedResearch({ id: "b", costUsd: 0.2 }),
      storedResearch({ id: "c", costUsd: 9, requestedAt: "2026-09-30T23:00:00.000Z" })
    )
    expect(await service.budget()).toEqual({ monthlyLimitUsd: 20, spentThisMonthUsd: 0.3, researchCountThisMonth: 2 })
  })

  it("changes the limit and records who did it", async () => {
    expect(await service.setMonthlyLimit(5, "santi")).toEqual({
      monthlyLimitUsd: 5,
      spentThisMonthUsd: 0,
      researchCountThisMonth: 0,
    })
    expect(repository.limitUpdate).toEqual({ updatedBy: "santi", updatedAt: NOW.toISOString() })
  })

  it("accepts a limit of zero", async () => {
    expect((await service.setMonthlyLimit(0, "santi")).monthlyLimitUsd).toBe(0)
  })

  it("rejects a negative or non-numeric limit", async () => {
    expect((await rejection(service.setMonthlyLimit(-1, "santi"))).reason).toBe("invalid_limit")
    expect((await rejection(service.setMonthlyLimit("5", "santi"))).reason).toBe("invalid_limit")
    expect(repository.limitUpdate).toBeNull()
  })

  it("lists a CUIT's history newest first", async () => {
    repository.saved.push(
      storedResearch({ id: "old", requestedAt: "2026-10-01T12:00:00.000Z" }),
      storedResearch({ id: "new", requestedAt: "2026-10-12T12:00:00.000Z" }),
      storedResearch({ id: "other", taxId: "20111111112" })
    )
    expect((await service.history(TAX_ID)).map((research) => research.id)).toEqual(["new", "old"])
  })

  it("rejects a malformed CUIT in the history", async () => {
    expect((await rejection(service.history("abc"))).reason).toBe("invalid_cuit")
  })

  it("lists the newest 50 researches of everyone", async () => {
    for (let i = 0; i < 55; i++) {
      repository.saved.push(storedResearch({ id: `r${i}`, requestedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }))
    }
    const recent = await service.recent()
    expect(recent).toHaveLength(50)
    expect(recent[0]?.id).toBe("r54")
  })
})
