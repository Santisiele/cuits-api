import type { CrmCuitAdd, ICrmRepository } from "@ports/interfaces"
import type {
  Change,
  ChangeEntityType,
  Contact,
  CrmCompany,
  CrmCompanyFields,
  CrmCuitState,
  RemovalFacts,
  RemovalOutcome,
} from "@domain/crm"

interface StoredCuit {
  taxId: string
  businessName: string
  company: boolean
  inSource: boolean
  archivedAt: string | null
  nosisPending: boolean
  nosisSearched: boolean
  otherSources: string[]
  knownSources: string[]
  relatedToBase: boolean
  fields: CrmCompanyFields
  addedAt: string | null
  addedBy: string | null
}

export class InMemoryCrmRepository implements ICrmRepository {
  readonly cuits = new Map<string, StoredCuit>()
  readonly contacts = new Map<string, Contact>()
  readonly changes: Change[] = []
  readonly deleted: string[] = []
  setupCalls = 0

  seedCuit(taxId: string, partial: Partial<StoredCuit> = {}): void {
    this.cuits.set(taxId, {
      taxId,
      businessName: "ACME SA",
      company: false,
      inSource: false,
      archivedAt: null,
      nosisPending: false,
      nosisSearched: false,
      otherSources: [],
      knownSources: [],
      relatedToBase: false,
      fields: { crmBrand: null, crmProduct: null, crmOrigin: null },
      addedAt: null,
      addedBy: null,
      ...partial,
    })
  }

  async ensureSetup(): Promise<void> {
    this.setupCalls++
  }

  async findCuitState(taxId: string): Promise<CrmCuitState> {
    const cuit = this.cuits.get(taxId)
    return {
      exists: cuit !== undefined,
      inCrm: cuit?.company === true && cuit.inSource,
      archived: cuit?.archivedAt != null,
      nosisSearched: cuit?.nosisSearched === true,
      inKnownSource: (cuit?.knownSources.length ?? 0) > 0,
    }
  }

  async addToCrm(add: CrmCuitAdd, change: Change): Promise<void> {
    if (!this.cuits.has(add.taxId)) this.seedCuit(add.taxId, { businessName: add.businessName ?? "" })
    const cuit = this.cuits.get(add.taxId)!
    cuit.inSource = true
    if (add.markNosisPending) cuit.nosisPending = true
    if (add.asCompany) {
      cuit.company = true
      cuit.archivedAt = null
      cuit.fields = { crmBrand: add.crmBrand, crmProduct: add.crmProduct, crmOrigin: add.crmOrigin }
      cuit.addedAt = add.at
      cuit.addedBy = add.by
    }
    this.changes.push(change)
  }

  async listCompanies(): Promise<CrmCompany[]> {
    return [...this.cuits.values()].filter((cuit) => cuit.company && cuit.inSource).map((cuit) => this.toCompany(cuit))
  }

  async findCompany(taxId: string): Promise<CrmCompany | null> {
    return (await this.listCompanies()).find((company) => company.taxId === taxId) ?? null
  }

  async updateCompany(taxId: string, fields: CrmCompanyFields, change: Change): Promise<void> {
    this.cuits.get(taxId)!.fields = fields
    this.changes.push(change)
  }

  async findRemovalFacts(taxId: string): Promise<RemovalFacts> {
    const cuit = this.cuits.get(taxId)!
    return {
      hasHistory: [...this.contacts.values()].some((contact) => contact.companyTaxIds.includes(taxId) || contact.cuil === taxId),
      hasOtherSource: cuit.otherSources.length > 0,
      relatedToBase: cuit.relatedToBase,
    }
  }

  async removeCompany(taxId: string, outcome: RemovalOutcome, at: string, change: Change): Promise<void> {
    this.changes.push(change)
    const cuit = this.cuits.get(taxId)!
    cuit.inSource = false
    cuit.company = false
    cuit.nosisPending = false
    if (outcome === "archived") cuit.archivedAt = at
    if (outcome === "deleted") {
      this.cuits.delete(taxId)
      this.deleted.push(taxId)
    }
  }

  async companiesInCrm(taxIds: string[]): Promise<string[]> {
    return taxIds.filter((taxId) => this.cuits.get(taxId)?.company === true && this.cuits.get(taxId)?.inSource === true)
  }

  async createContact(contact: Contact, change: Change): Promise<void> {
    this.contacts.set(contact.id, { ...contact })
    this.changes.push(change)
  }

  async findContact(id: string): Promise<Contact | null> {
    const contact = this.contacts.get(id)
    return contact ? { ...contact } : null
  }

  async updateContact(contact: Contact, change: Change): Promise<void> {
    this.contacts.set(contact.id, { ...contact })
    this.changes.push(change)
  }

  async listContacts(taxId: string): Promise<Contact[]> {
    return [...this.contacts.values()].filter((contact) => contact.archivedAt === null && contact.companyTaxIds.includes(taxId))
  }

  async listChanges(entityType: ChangeEntityType, entityId: string): Promise<Change[]> {
    return this.changes.filter((change) => change.entityType === entityType && change.entityId === entityId).reverse()
  }

  private toCompany(cuit: StoredCuit): CrmCompany {
    return {
      taxId: cuit.taxId,
      businessName: cuit.businessName,
      ...cuit.fields,
      nosisPending: cuit.nosisPending,
      addedAt: cuit.addedAt,
      addedBy: cuit.addedBy,
      lastActionDate: null,
      nextDueDate: null,
      openTaskCount: 0,
    }
  }
}
