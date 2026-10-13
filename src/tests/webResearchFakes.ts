import type { IWebResearcher, IWebResearchRepository } from "@ports/interfaces"
import {
  DEFAULT_MONTHLY_LIMIT_USD,
  type ResearchFindings,
  type ResearchSubject,
  type WebResearch,
  type WebResearchWithName,
} from "@domain/webResearch"

export class InMemoryWebResearchRepository implements IWebResearchRepository {
  readonly saved: WebResearch[] = []
  readonly subjects = new Map<string, { businessName: string; inMyBase: boolean }>()
  monthlyLimitUsd: number | null = null
  limitUpdate: { updatedBy: string; updatedAt: string } | null = null

  async findSubject(taxId: string) {
    return this.subjects.get(taxId) ?? null
  }

  async save(research: WebResearch): Promise<void> {
    this.saved.push(research)
  }

  async listForCuit(taxId: string): Promise<WebResearch[]> {
    return this.newestFirst().filter((research) => research.taxId === taxId)
  }

  async listRecent(limit: number): Promise<WebResearchWithName[]> {
    return this.newestFirst()
      .slice(0, limit)
      .map((research) => ({ ...research, businessName: this.subjects.get(research.taxId)?.businessName ?? "" }))
  }

  async getMonthlyLimit(): Promise<number> {
    return this.monthlyLimitUsd ?? DEFAULT_MONTHLY_LIMIT_USD
  }

  async setMonthlyLimit(monthlyLimitUsd: number, updatedBy: string, updatedAt: string): Promise<void> {
    this.monthlyLimitUsd = monthlyLimitUsd
    this.limitUpdate = { updatedBy, updatedAt }
  }

  async spendSince(since: string): Promise<{ totalUsd: number; count: number }> {
    const inMonth = this.saved.filter((research) => research.requestedAt >= since)
    return { totalUsd: inMonth.reduce((sum, research) => sum + research.costUsd, 0), count: inMonth.length }
  }

  private newestFirst(): WebResearch[] {
    return [...this.saved].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
  }
}

export class FakeResearcher implements IWebResearcher {
  readonly calls: ResearchSubject[] = []
  failure: Error | null = null

  constructor(
    public findings: ResearchFindings = {
      summary: "ACME SA es una constructora.",
      sources: [{ url: "https://boletin.gob.ar/1", title: "Boletín Oficial" }],
      model: "claude-opus-5-5",
      usage: { inputTokens: 50_000, outputTokens: 4_000, cacheReadTokens: 10_000, webSearches: 6 },
    }
  ) {}

  async research(subject: ResearchSubject): Promise<ResearchFindings> {
    this.calls.push(subject)
    if (this.failure) throw this.failure
    return this.findings
  }
}

export function storedResearch(overrides: Partial<WebResearch> = {}): WebResearch {
  return {
    id: "r1",
    taxId: "30712345678",
    requestedAt: "2026-10-10T12:00:00.000Z",
    requestedBy: "santi",
    status: "done",
    summary: "Resumen",
    sources: [{ url: "https://a.com", title: "A" }],
    model: "claude-opus-5-5",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    webSearches: 4,
    costUsd: 1.5,
    ...overrides,
  }
}
