import { randomUUID } from "crypto"
import type { ICrmRepository } from "@ports/interfaces.js"
import {
  MAX_NAME_LENGTH,
  changedFields,
  cleanText,
  isTooLong,
  isValidBirthday,
  isValidCrmCuit,
  isValidCrmId,
  removalOutcome,
  shouldMarkNosisPending,
  uniqueTaxIds,
  type Change,
  type ChangeEntityType,
  type ChangeOperation,
  type Contact,
  type CrmCompany,
  type CrmCompanyFields,
  type CrmRejection,
  type RemovalOutcome,
} from "@domain/crm.js"

export class CrmError extends Error {
  constructor(readonly reason: CrmRejection, message: string) {
    super(message)
    this.name = "CrmError"
  }
}

export interface CompanyAddResult {
  taxId: string
  created: boolean
  restored: boolean
  nosisPending: boolean
}

export interface CompanyRemovalResult {
  outcome: RemovalOutcome
  dryRun: boolean
}

export interface CompanyDetail {
  company: CrmCompany
  contacts: Contact[]
}

interface CompanyBody {
  taxId?: unknown
  businessName?: unknown
  crmBrand?: unknown
  crmProduct?: unknown
  crmOrigin?: unknown
}

interface ContactBody {
  fullName?: unknown
  companyTaxIds?: unknown
  phone?: unknown
  email?: unknown
  birthday?: unknown
  cuil?: unknown
}

const MESSAGES: Record<CrmRejection, string> = {
  invalid_cuit: "The CUIT must be 11 digits without dashes",
  business_name_required: "A business name is required for a CUIT that is not in the graph",
  full_name_required: "The contact needs a full name",
  company_required: "The contact needs at least one company",
  invalid_date: "The date is not valid",
  text_too_long: "The text is too long",
  company_not_in_crm: "That company is not in the CRM",
  already_in_crm: "That company is already in the CRM",
  contact_not_found: "That contact does not exist",
  already_archived: "It is already archived",
  not_archived: "It is not archived",
  cuil_already_set: "The contact already has a CUIL",
}

export class CrmService {
  constructor(
    private readonly repository: ICrmRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID
  ) {}

  listCompanies(): Promise<CrmCompany[]> {
    return this.repository.listCompanies()
  }

  async companyDetail(taxId: string): Promise<CompanyDetail> {
    const company = await this.requireCompany(taxId)
    return { company, contacts: await this.repository.listContacts(taxId) }
  }

  async addCompany(body: CompanyBody, by: string): Promise<CompanyAddResult> {
    const taxId = this.requireCuit(body.taxId)
    const fields = this.companyFields(body)
    const businessName = this.name(body.businessName)
    const state = await this.repository.findCuitState(taxId)
    if (state.inCrm) this.fail("already_in_crm")
    if (!state.exists && businessName === null) this.fail("business_name_required")

    const markNosisPending = shouldMarkNosisPending(state)
    const at = this.now().toISOString()
    await this.repository.addToCrm(
      { taxId, businessName, ...fields, asCompany: true, markNosisPending, at, by },
      this.change(at, by, "CrmCompany", taxId, "crm_add", {}, { businessName, ...fields })
    )
    return { taxId, created: !state.exists, restored: state.archived, nosisPending: markNosisPending }
  }

  async updateCompany(taxId: string, body: CompanyBody, by: string): Promise<CrmCompany> {
    const company = await this.requireCompany(taxId)
    const fields = this.companyFields(body)
    const at = this.now().toISOString()
    const diff = changedFields(company as unknown as Record<string, unknown>, { ...fields })
    await this.repository.updateCompany(taxId, fields, this.change(at, by, "CrmCompany", taxId, "update", diff.before, diff.after))
    return { ...company, ...fields }
  }

  async removeCompany(taxId: string, dryRun: boolean, by: string): Promise<CompanyRemovalResult> {
    await this.requireCompany(taxId)
    const outcome = removalOutcome(await this.repository.findRemovalFacts(taxId))
    if (dryRun) return { outcome, dryRun }
    const at = this.now().toISOString()
    await this.repository.removeCompany(taxId, outcome, at, this.change(at, by, "CrmCompany", taxId, "crm_remove", {}, { outcome }))
    return { outcome, dryRun }
  }

  async createContact(body: ContactBody, by: string): Promise<Contact> {
    const fullName = this.requireFullName(body.fullName)
    const companyTaxIds = await this.requireCompanies(body.companyTaxIds)
    const cuil = body.cuil === undefined || body.cuil === null || body.cuil === "" ? null : this.requireCuit(body.cuil)
    const at = this.now().toISOString()
    const contact: Contact = {
      id: this.newId(),
      fullName,
      phone: this.name(body.phone),
      email: this.name(body.email),
      birthday: this.birthday(body.birthday),
      cuil,
      companyTaxIds,
      createdAt: at,
      archivedAt: null,
    }
    if (cuil) await this.addPerson(cuil, fullName, at, by)
    await this.repository.createContact(contact, this.change(at, by, "Contact", contact.id, "create", {}, this.contactView(contact)))
    return contact
  }

  async updateContact(id: string, body: ContactBody, by: string): Promise<Contact> {
    const contact = await this.requireContact(id)
    const updated: Contact = {
      ...contact,
      fullName: body.fullName === undefined ? contact.fullName : this.requireFullName(body.fullName),
      phone: body.phone === undefined ? contact.phone : this.name(body.phone),
      email: body.email === undefined ? contact.email : this.name(body.email),
      birthday: body.birthday === undefined ? contact.birthday : this.birthday(body.birthday),
      companyTaxIds: body.companyTaxIds === undefined ? contact.companyTaxIds : await this.requireCompanies(body.companyTaxIds),
    }
    const at = this.now().toISOString()
    if (body.cuil !== undefined && body.cuil !== null && body.cuil !== "" && body.cuil !== contact.cuil) {
      if (contact.cuil !== null) this.fail("cuil_already_set")
      updated.cuil = this.requireCuit(body.cuil)
      await this.addPerson(updated.cuil, updated.fullName, at, by)
    }
    const diff = changedFields(this.contactView(contact), this.contactView(updated))
    await this.repository.updateContact(updated, this.change(at, by, "Contact", id, "update", diff.before, diff.after))
    return updated
  }

  async archiveContact(id: string, by: string): Promise<Contact> {
    const contact = await this.requireContact(id)
    if (contact.archivedAt !== null) this.fail("already_archived")
    const at = this.now().toISOString()
    const archived = { ...contact, archivedAt: at }
    await this.repository.updateContact(archived, this.change(at, by, "Contact", id, "archive", { archivedAt: null }, { archivedAt: at }))
    return archived
  }

  async restoreContact(id: string, by: string): Promise<Contact> {
    const contact = await this.requireContact(id)
    if (contact.archivedAt === null) this.fail("not_archived")
    const at = this.now().toISOString()
    const restored = { ...contact, archivedAt: null }
    await this.repository.updateContact(
      restored,
      this.change(at, by, "Contact", id, "restore", { archivedAt: contact.archivedAt }, { archivedAt: null })
    )
    return restored
  }

  private async addPerson(taxId: string, businessName: string, at: string, by: string): Promise<void> {
    const state = await this.repository.findCuitState(taxId)
    const markNosisPending = shouldMarkNosisPending(state)
    await this.repository.addToCrm(
      {
        taxId,
        businessName,
        crmBrand: null,
        crmProduct: null,
        crmOrigin: null,
        asCompany: false,
        markNosisPending,
        at,
        by,
      },
      this.change(at, by, "CrmCompany", taxId, "crm_add", {}, { businessName, asContact: true })
    )
  }

  private contactView(contact: Contact): Record<string, unknown> {
    return {
      fullName: contact.fullName,
      phone: contact.phone,
      email: contact.email,
      birthday: contact.birthday,
      cuil: contact.cuil,
      companyTaxIds: contact.companyTaxIds,
    }
  }

  private change(
    at: string,
    by: string,
    entityType: ChangeEntityType,
    entityId: string,
    operation: ChangeOperation,
    before: Record<string, unknown>,
    after: Record<string, unknown>
  ): Change {
    return { id: this.newId(), at, by, entityType, entityId, operation, before, after }
  }

  private async requireCompany(taxId: string): Promise<CrmCompany> {
    this.requireCuit(taxId)
    const company = await this.repository.findCompany(taxId)
    if (!company) this.fail("company_not_in_crm")
    return company
  }

  private async requireContact(id: string): Promise<Contact> {
    const contact = isValidCrmId(id) ? await this.repository.findContact(id) : null
    if (!contact) this.fail("contact_not_found")
    return contact
  }

  private async requireCompanies(value: unknown): Promise<string[]> {
    const taxIds = uniqueTaxIds(value)
    if (taxIds === null) this.fail("invalid_cuit")
    if (taxIds.length === 0) this.fail("company_required")
    const inCrm = await this.repository.companiesInCrm(taxIds)
    if (inCrm.length !== taxIds.length) this.fail("company_not_in_crm")
    return taxIds
  }

  private requireCuit(value: unknown): string {
    if (!isValidCrmCuit(value)) this.fail("invalid_cuit")
    return value
  }

  private requireFullName(value: unknown): string {
    const fullName = this.name(value)
    if (fullName === null) this.fail("full_name_required")
    return fullName
  }

  private companyFields(body: CompanyBody): CrmCompanyFields {
    return {
      crmBrand: this.name(body.crmBrand),
      crmProduct: this.name(body.crmProduct),
      crmOrigin: this.name(body.crmOrigin),
    }
  }

  private birthday(value: unknown): string | null {
    const birthday = cleanText(value)
    if (birthday !== null && !isValidBirthday(birthday)) this.fail("invalid_date")
    return birthday
  }

  private name(value: unknown): string | null {
    const text = cleanText(value)
    if (isTooLong(text, MAX_NAME_LENGTH)) this.fail("text_too_long")
    return text
  }

  private fail(reason: CrmRejection): never {
    throw new CrmError(reason, MESSAGES[reason])
  }
}
