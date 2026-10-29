import {
  COMPANY_REMOVED_REASON,
  changedFields,
  cleanText,
  isChangeEntityType,
  removalOutcome,
  shouldMarkNosisPending,
  withCurrentFields,
  type Change,
  type CrmCompany,
  type CrmCompanyFields,
  type CrmSource,
  type CrmUser,
} from "@domain/crm.js"
import {
  CrmServiceBase,
  type CompanyAddResult,
  type CompanyBody,
  type CompanyCloseResult,
  type CompanyDetail,
  type CompanyRemovalResult,
} from "@application/CrmServiceBase.js"

/** Companies in the CRM: adding, editing, closing, removing and their history. */
export class CrmCompanyService extends CrmServiceBase {
  listCompanies(): Promise<CrmCompany[]> {
    return this.repository.listCompanies()
  }

  listUsers(): Promise<CrmUser[]> {
    return this.repository.listActiveUsers()
  }

  async companyDetail(taxId: string): Promise<CompanyDetail> {
    const company = await this.requireCompany(taxId)
    const [contacts, actions, tasks] = await Promise.all([
      this.repository.listContacts(taxId),
      this.repository.listActions(taxId),
      this.repository.listTasks(taxId),
    ])
    return { company, contacts, actions, tasks }
  }

  async addCompany(body: CompanyBody, by: string): Promise<CompanyAddResult> {
    const taxId = this.requireCuit(body.taxId)
    const { fields, joinsKnownSource } = await this.companyFields(body)
    const businessName = this.name(body.businessName)
    const state = await this.repository.findCuitState(taxId)
    if (state.inCrm) this.fail("already_in_crm")
    if (!state.exists && businessName === null) this.fail("business_name_required")

    const markNosisPending = shouldMarkNosisPending(state, joinsKnownSource)
    const at = this.now().toISOString()
    await this.repository.addToCrm(
      { taxId, businessName, ...fields, asCompany: true, markNosisPending, at, by },
      this.change(at, by, "CrmCompany", taxId, "crm_add", {}, { businessName, ...fields })
    )
    return { taxId, created: !state.exists, restored: state.archived, nosisPending: markNosisPending }
  }

  async updateCompany(taxId: string, body: CompanyBody, by: string): Promise<CrmCompany> {
    const company = await this.requireCompany(taxId)
    const { fields, joinsKnownSource } = await this.companyFields(withCurrentFields(body, company))
    const changesSource = fields.originSource !== company.originSource
    const markNosisPending =
      changesSource && joinsKnownSource && shouldMarkNosisPending(await this.repository.findCuitState(taxId), joinsKnownSource)
    const at = this.now().toISOString()
    const diff = changedFields(company as unknown as Record<string, unknown>, { ...fields })
    await this.repository.updateCompany(
      taxId,
      fields,
      company.originSource,
      markNosisPending,
      this.change(at, by, "CrmCompany", taxId, "update", diff.before, diff.after)
    )
    return { ...company, ...fields, nosisPending: company.nosisPending || markNosisPending }
  }

  async closeCompany(taxId: string, reasonValue: unknown, by: string): Promise<CompanyCloseResult> {
    const company = await this.requireCompany(taxId)
    if (company.closedAt !== null) this.fail("company_closed")
    const reason = this.text(reasonValue)
    if (reason === null) this.fail("close_reason_required")
    const at = this.now().toISOString()
    const { inservible, cancelledTaskIds } = await this.repository.closeCompany(
      taxId,
      reason,
      at,
      by,
      this.change(at, by, "CrmCompany", taxId, "close", { closedAt: null }, { closedAt: at, closedReason: reason }),
      (id) => this.change(at, by, "Task", id, "cancel", { status: "open" }, { status: "cancelled", cancelReason: reason })
    )
    return {
      company: { ...company, closedAt: at, closedReason: reason, closedBy: by, nextDueDate: null, openTaskCount: 0 },
      cancelledTaskCount: cancelledTaskIds.length,
      inservible,
    }
  }

  async reopenCompany(taxId: string, by: string): Promise<CrmCompany> {
    const company = await this.requireCompany(taxId)
    if (company.closedAt === null) this.fail("not_closed")
    const at = this.now().toISOString()
    await this.repository.reopenCompany(
      taxId,
      this.change(at, by, "CrmCompany", taxId, "reopen", { closedAt: company.closedAt, closedReason: company.closedReason }, { closedAt: null })
    )
    return { ...company, closedAt: null, closedReason: null, closedBy: null }
  }

  listSources(): Promise<CrmSource[]> {
    return this.repository.listSources()
  }

  async removeCompany(taxId: string, dryRun: boolean, by: string): Promise<CompanyRemovalResult> {
    await this.requireCompany(taxId)
    const facts = await this.repository.findRemovalFacts(taxId)
    const outcome = removalOutcome(facts)
    const cancelledTaskIds = outcome === "archived" ? facts.openTaskIds : []
    const result = { outcome, cancelledTaskCount: cancelledTaskIds.length, dryRun }
    if (dryRun) return result
    const at = this.now().toISOString()
    await this.repository.removeCompany(taxId, outcome, at, [
      this.change(at, by, "CrmCompany", taxId, "crm_remove", {}, { outcome }),
      ...cancelledTaskIds.map((id) =>
        this.change(at, by, "Task", id, "cancel", { status: "open" }, { status: "cancelled", cancelReason: COMPANY_REMOVED_REASON })
      ),
    ])
    return result
  }

  async changes(entityType: unknown, entityId: unknown): Promise<Change[]> {
    if (!isChangeEntityType(entityType)) this.fail("invalid_entity")
    if (typeof entityId !== "string" || entityId === "") this.fail("invalid_entity")
    return this.repository.listChanges(entityType, entityId)
  }

  private async companyFields(body: CompanyBody): Promise<{ fields: CrmCompanyFields; joinsKnownSource: boolean }> {
    const originSource = cleanText(body.originSource)
    const source = originSource === null ? null : await this.repository.findSource(originSource)
    if (originSource !== null && source === null) this.fail("source_not_found")
    return {
      fields: {
        crmBrand: this.name(body.crmBrand),
        crmProduct: this.name(body.crmProduct),
        crmOrigin: originSource === null ? this.name(body.crmOrigin) : null,
        originSource,
      },
      joinsKnownSource: source?.category === "known",
    }
  }
}
