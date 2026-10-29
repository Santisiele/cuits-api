import type { CrmCuitAdd, ICrmRepository, INosisPendingRepository } from "@ports/interfaces"
import type { NosisPendingItem } from "@domain/nosisPending"
import type {
  Action,
  AgendaItem,
  Task,
  Change,
  ChangeEntityType,
  Contact,
  CrmCompany,
  CrmCompanyFields,
  CrmCuitState,
  CrmUser,
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

export class InMemoryCrmRepository implements ICrmRepository, INosisPendingRepository {
  readonly cuits = new Map<string, StoredCuit>()
  readonly contacts = new Map<string, Contact>()
  readonly changes: Change[] = []
  readonly deleted: string[] = []
  readonly actions = new Map<string, Action>()
  readonly tasks = new Map<string, Task>()
  users = ["santi", "Flavia", "pedro"]
  readonly colors = new Map<string, string>()
  readonly searchedAt = new Map<string, string>()
  mailDay: string | null = null
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
    const tasks = [...this.tasks.values()].filter((task) => task.companyTaxId === taxId)
    return {
      hasHistory:
        [...this.contacts.values()].some((contact) => contact.companyTaxIds.includes(taxId) || contact.cuil === taxId) ||
        [...this.actions.values()].some((action) => action.companyTaxId === taxId) ||
        tasks.length > 0,
      hasOtherSource: cuit.otherSources.length > 0,
      relatedToBase: cuit.relatedToBase,
      openTaskIds: tasks.filter((task) => task.status === "open" && task.archivedAt === null).map((task) => task.id),
    }
  }

  async removeCompany(taxId: string, outcome: RemovalOutcome, at: string, changes: Change[]): Promise<void> {
    this.changes.push(...changes)
    if (outcome === "archived") {
      for (const task of this.tasks.values()) {
        if (task.companyTaxId === taxId && task.status === "open" && task.archivedAt === null) {
          Object.assign(task, { status: "cancelled", cancelReason: "company_removed", closedAt: at })
        }
      }
    }
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

  async listNosisPending(): Promise<NosisPendingItem[]> {
    return [...this.cuits.values()]
      .filter((cuit) => cuit.nosisPending)
      .map((cuit) => ({ taxId: cuit.taxId, businessName: cuit.businessName, sources: [], addedBy: cuit.addedBy, addedAt: cuit.addedAt }))
  }

  async markNosisSearched(taxId: string, businessName: string, at: string): Promise<void> {
    const cuit = this.cuits.get(taxId)!
    cuit.nosisPending = false
    cuit.nosisSearched = true
    if (!cuit.businessName) cuit.businessName = businessName
    this.searchedAt.set(taxId, at)
  }

  async lastPendingMailDay(): Promise<string | null> {
    return this.mailDay
  }

  async recordPendingMail(day: string): Promise<void> {
    this.mailDay = day
  }

  async listActiveUsers(): Promise<CrmUser[]> {
    return this.users.map((username) => ({ username, color: this.colors.get(username) ?? null }))
  }

  async contactsAtCompany(taxId: string, contactIds: string[]): Promise<string[]> {
    return contactIds.filter((id) => {
      const contact = this.contacts.get(id)
      return contact !== undefined && contact.archivedAt === null && contact.companyTaxIds.includes(taxId)
    })
  }

  async findAction(id: string): Promise<Action | null> {
    const action = this.actions.get(id)
    return action ? { ...action } : null
  }

  async findTask(id: string): Promise<Task | null> {
    const task = this.tasks.get(id)
    return task ? { ...task } : null
  }

  async recordAction(action: Action, closedTasks: Task[], nextTask: Task | null, changes: Change[]): Promise<void> {
    this.actions.set(action.id, { ...action })
    for (const task of closedTasks) this.tasks.set(task.id, { ...task })
    if (nextTask) this.tasks.set(nextTask.id, { ...nextTask })
    this.changes.push(...changes)
  }

  async updateAction(action: Action, change: Change): Promise<void> {
    this.actions.set(action.id, { ...action })
    this.changes.push(change)
  }

  async createTask(task: Task, change: Change): Promise<void> {
    this.tasks.set(task.id, { ...task })
    this.changes.push(change)
  }

  async updateTask(task: Task, change: Change): Promise<void> {
    this.tasks.set(task.id, { ...task })
    this.changes.push(change)
  }

  async listActions(taxId: string): Promise<Action[]> {
    return [...this.actions.values()].filter((action) => action.companyTaxId === taxId && action.archivedAt === null)
  }

  async listTasks(taxId: string): Promise<Task[]> {
    return [...this.tasks.values()].filter((task) => task.companyTaxId === taxId && task.archivedAt === null)
  }

  async listAgenda(assignee: string | null): Promise<Omit<AgendaItem, "overdue">[]> {
    return [...this.tasks.values()]
      .filter((task) => task.status === "open" && task.archivedAt === null)
      .filter((task) => assignee === null || task.assignee.toLowerCase() === assignee.toLowerCase())
      .map((task) => ({ ...task, businessName: this.cuits.get(task.companyTaxId)?.businessName ?? "" }))
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
