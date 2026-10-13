import { randomUUID } from "crypto"
import type { IWebResearcher, IWebResearchRepository } from "@ports/interfaces.js"
import {
  EMPTY_USAGE,
  ResearcherError,
  costFromUsage,
  isBudgetExhausted,
  isValidMonthlyLimit,
  isValidResearchCuit,
  roundUsd,
  startOfMonthInBuenosAires,
  type ResearchBudget,
  type ResearchUsage,
  type WebResearch,
  type WebResearchRejection,
  type WebResearchWithName,
} from "@domain/webResearch.js"

export class WebResearchError extends Error {
  constructor(
    readonly reason: WebResearchRejection,
    message: string,
    readonly research: WebResearch | null = null,
    readonly detail: string | null = null
  ) {
    super(message)
    this.name = "WebResearchError"
  }
}

const RECENT_LIMIT = 50

export class WebResearchService {
  constructor(
    private readonly repository: IWebResearchRepository,
    private readonly researcher: IWebResearcher | null,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID
  ) {}

  async research(taxId: string, requestedBy: string): Promise<WebResearch> {
    this.requireCuit(taxId)
    if (!this.researcher) {
      throw new WebResearchError("research_off", "Web research is not configured")
    }
    const subject = await this.repository.findSubject(taxId)
    if (!subject?.inMyBase) {
      throw new WebResearchError("not_in_base", "That CUIT is not in the base")
    }
    const budget = await this.budget()
    if (isBudgetExhausted(budget.spentThisMonthUsd, budget.monthlyLimitUsd)) {
      throw new WebResearchError("budget_exhausted", "The monthly spending limit has been reached")
    }

    const requestedAt = this.now().toISOString()
    try {
      const findings = await this.researcher.research({ businessName: subject.businessName, taxId })
      const research = this.record(taxId, requestedAt, requestedBy, "done", findings.summary, findings.sources, findings.model, findings.usage)
      await this.repository.save(research)
      return research
    } catch (err) {
      const usage = err instanceof ResearcherError ? err.usage : EMPTY_USAGE
      const model = err instanceof ResearcherError ? err.model : ""
      const research = this.record(taxId, requestedAt, requestedBy, "failed", "", [], model, usage)
      await this.repository.save(research)
      throw new WebResearchError(
        "research_failed",
        "The web research could not be completed",
        research,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  async history(taxId: string): Promise<WebResearch[]> {
    this.requireCuit(taxId)
    return this.repository.listForCuit(taxId)
  }

  recent(): Promise<WebResearchWithName[]> {
    return this.repository.listRecent(RECENT_LIMIT)
  }

  async budget(): Promise<ResearchBudget> {
    const monthlyLimitUsd = await this.repository.getMonthlyLimit()
    const spend = await this.repository.spendSince(startOfMonthInBuenosAires(this.now()))
    return {
      monthlyLimitUsd,
      spentThisMonthUsd: roundUsd(spend.totalUsd),
      researchCountThisMonth: spend.count,
    }
  }

  async setMonthlyLimit(value: unknown, updatedBy: string): Promise<ResearchBudget> {
    if (!isValidMonthlyLimit(value)) {
      throw new WebResearchError("invalid_limit", "The limit must be a number greater than or equal to 0")
    }
    await this.repository.setMonthlyLimit(value, updatedBy, this.now().toISOString())
    return this.budget()
  }

  private requireCuit(taxId: string): void {
    if (!isValidResearchCuit(taxId)) {
      throw new WebResearchError("invalid_cuit", "The CUIT must be 11 digits without dashes")
    }
  }

  private record(
    taxId: string,
    requestedAt: string,
    requestedBy: string,
    status: WebResearch["status"],
    summary: string,
    sources: WebResearch["sources"],
    model: string,
    usage: ResearchUsage
  ): WebResearch {
    return {
      id: this.newId(),
      taxId,
      requestedAt,
      requestedBy,
      status,
      summary,
      sources,
      model,
      ...usage,
      costUsd: this.researcher ? costFromUsage(usage, this.researcher.prices) : 0,
    }
  }
}
