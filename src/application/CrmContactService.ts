import type { CrmPersonAdd } from "@ports/interfaces.js"
import { changedFields, cleanText, isValidBirthday, isValidCrmId, uniqueTaxIds, type Contact } from "@domain/crm.js"
import { CrmServiceBase, type ContactBody } from "@application/CrmServiceBase.js"

/** Contacts of CRM companies. */
export class CrmContactService extends CrmServiceBase {
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
    await this.repository.createContact(
      contact,
      this.change(at, by, "Contact", contact.id, "create", {}, this.contactView(contact)),
      cuil ? this.personAdd(cuil, fullName, at, by) : null
    )
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
    let person: CrmPersonAdd | null = null
    if (body.cuil !== undefined && body.cuil !== null && body.cuil !== "" && body.cuil !== contact.cuil) {
      if (contact.cuil !== null) this.fail("cuil_already_set")
      updated.cuil = this.requireCuit(body.cuil)
      person = this.personAdd(updated.cuil, updated.fullName, at, by)
    }
    const diff = changedFields(this.contactView(contact), this.contactView(updated))
    await this.repository.updateContact(updated, this.change(at, by, "Contact", id, "update", diff.before, diff.after), person)
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

  private personAdd(taxId: string, businessName: string, at: string, by: string): CrmPersonAdd {
    return {
      add: {
        taxId,
        businessName,
        crmBrand: null,
        crmProduct: null,
        crmOrigin: null,
        originSource: null,
        asCompany: false,
        markNosisPending: false,
        at,
        by,
      },
      change: this.change(at, by, "CrmCompany", taxId, "crm_add", {}, { businessName, asContact: true }),
    }
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

  private requireFullName(value: unknown): string {
    const fullName = this.name(value)
    if (fullName === null) this.fail("full_name_required")
    return fullName
  }

  private birthday(value: unknown): string | null {
    const birthday = cleanText(value)
    if (birthday !== null && !isValidBirthday(birthday)) this.fail("invalid_date")
    return birthday
  }
}
