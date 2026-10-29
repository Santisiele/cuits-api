import { randomUUID } from "crypto"
import type { ICrmRepository } from "@ports/interfaces.js"
import {
  COMPANY_REMOVED_REASON,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  canChangeAction,
  canChangeTask,
  changedFields,
  cleanText,
  isChangeEntityType,
  isOverdue,
  isTooLong,
  isValidBirthday,
  isValidCalendarDate,
  isValidCrmCuit,
  isValidCrmId,
  removalOutcome,
  shouldMarkNosisPending,
  sortAgenda,
  taskStatusRejection,
  todayInBuenosAires,
  uniqueIds,
  uniqueTaxIds,
  type Action,
  type Actor,
  type AgendaItem,
  type Change,
  type ChangeEntityType,
  type ChangeOperation,
  type Contact,
  type CrmCompany,
  type CrmCompanyFields,
  type CrmRejection,
  type CrmSource,
  type CrmUser,
  type RemovalOutcome,
  type Task,
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
  cancelledTaskCount: number
  dryRun: boolean
}

export interface CompanyDetail {
  company: CrmCompany
  contacts: Contact[]
  actions: Action[]
  tasks: Task[]
}

export interface ActionResult {
  action: Action
  closedTasks: Task[]
  nextTask: Task | null
}

interface CompanyBody {
  taxId?: unknown
  businessName?: unknown
  crmBrand?: unknown
  crmProduct?: unknown
  crmOrigin?: unknown
  originSource?: unknown
}

export interface CompanyCloseResult {
  company: CrmCompany
  cancelledTaskCount: number
  inservible: boolean
}

interface ContactBody {
  fullName?: unknown
  companyTaxIds?: unknown
  phone?: unknown
  email?: unknown
  birthday?: unknown
  cuil?: unknown
}

interface TaskBody {
  companyTaxId?: unknown
  description?: unknown
  dueDate?: unknown
  assignee?: unknown
  contactIds?: unknown
  status?: unknown
  cancelReason?: unknown
}

interface ActionBody {
  companyTaxId?: unknown
  date?: unknown
  description?: unknown
  contactIds?: unknown
  completesTaskIds?: unknown
  nextTask?: TaskBody | null
}

export interface AgendaQuery {
  assignee?: string
  overdueOnly?: string
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
  description_required: "A description is required",
  cancel_reason_required: "A reason is required to cancel a task",
  invalid_status: "A task can only be marked done or cancelled",
  task_not_open: "That task is no longer open",
  task_other_company: "That task belongs to another company",
  forbidden: "You are not allowed to do this",
  action_not_found: "That action does not exist",
  task_not_found: "That task does not exist",
  user_not_found: "That user does not exist",
  invalid_entity: "Unknown history entry type",
  next_task_required: "Every action has to leave the next task",
  close_reason_required: "A reason is required to close a company",
  company_closed: "That company is closed",
  not_closed: "That company is not closed",
  source_not_found: "That source does not exist",
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
    const { fields, joinsKnownSource } = await this.companyFields(body)
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
    const openTaskIds = (await this.repository.findRemovalFacts(taxId)).openTaskIds
    const at = this.now().toISOString()
    const { inservible } = await this.repository.closeCompany(taxId, reason, at, by, [
      this.change(at, by, "CrmCompany", taxId, "close", { closedAt: null }, { closedAt: at, closedReason: reason }),
      ...openTaskIds.map((id) =>
        this.change(at, by, "Task", id, "cancel", { status: "open" }, { status: "cancelled", cancelReason: reason })
      ),
    ])
    return {
      company: { ...company, closedAt: at, closedReason: reason, closedBy: by, nextDueDate: null, openTaskCount: 0 },
      cancelledTaskCount: openTaskIds.length,
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

  async recordAction(body: ActionBody, actor: Actor): Promise<ActionResult> {
    const companyTaxId = this.requireCuit(body.companyTaxId)
    await this.requireOpenCompany(companyTaxId)
    const date = this.calendarDate(body.date)
    const description = this.description(body.description)
    const contactIds = await this.requireContacts(companyTaxId, body.contactIds)
    const completesTaskIds = uniqueIds(body.completesTaskIds)
    if (completesTaskIds === null) this.fail("task_not_found")
    const toClose = await Promise.all(completesTaskIds.map((id) => this.requireOpenTaskOf(id, companyTaxId)))
    if (!body.nextTask) this.fail("next_task_required")
    const nextTask = await this.newTask({ ...body.nextTask, companyTaxId }, actor.username)

    const at = this.now().toISOString()
    const action: Action = {
      id: this.newId(),
      companyTaxId,
      date,
      description,
      doneBy: actor.username,
      contactIds,
      createdTaskId: nextTask?.id ?? null,
      completedTaskIds: completesTaskIds,
      createdAt: at,
      archivedAt: null,
    }
    const closedTasks = toClose.map((task) => ({ ...task, status: "done" as const, closedAt: at }))
    await this.repository.recordAction(action, closedTasks, nextTask && { ...nextTask, createdAt: at }, [
      this.change(at, actor.username, "Action", action.id, "create", {}, this.actionView(action)),
      ...closedTasks.map((task) =>
        this.change(at, actor.username, "Task", task.id, "complete", { status: "open" }, { status: "done", byAction: action.id })
      ),
      ...(nextTask ? [this.change(at, actor.username, "Task", nextTask.id, "create", {}, this.taskView(nextTask))] : []),
    ])
    return { action, closedTasks, nextTask: nextTask && { ...nextTask, createdAt: at } }
  }

  async updateAction(id: string, body: ActionBody, actor: Actor): Promise<Action> {
    const action = await this.requireChangeableAction(id, actor)
    const updated: Action = {
      ...action,
      date: body.date === undefined ? action.date : this.calendarDate(body.date),
      description: body.description === undefined ? action.description : this.description(body.description),
      contactIds: body.contactIds === undefined ? action.contactIds : await this.requireContacts(action.companyTaxId, body.contactIds),
    }
    const at = this.now().toISOString()
    const diff = changedFields(this.actionView(action), this.actionView(updated))
    await this.repository.updateAction(updated, this.change(at, actor.username, "Action", id, "update", diff.before, diff.after))
    return updated
  }

  async archiveAction(id: string, actor: Actor): Promise<Action> {
    const action = await this.requireChangeableAction(id, actor)
    if (action.archivedAt !== null) this.fail("already_archived")
    const at = this.now().toISOString()
    const archived = { ...action, archivedAt: at }
    await this.repository.updateAction(archived, this.change(at, actor.username, "Action", id, "archive", { archivedAt: null }, { archivedAt: at }))
    return archived
  }

  async restoreAction(id: string, actor: Actor): Promise<Action> {
    const action = await this.requireChangeableAction(id, actor)
    if (action.archivedAt === null) this.fail("not_archived")
    const at = this.now().toISOString()
    const restored = { ...action, archivedAt: null }
    await this.repository.updateAction(
      restored,
      this.change(at, actor.username, "Action", id, "restore", { archivedAt: action.archivedAt }, { archivedAt: null })
    )
    return restored
  }

  async createTask(body: TaskBody, actor: Actor): Promise<Task> {
    const companyTaxId = this.requireCuit(body.companyTaxId)
    await this.requireOpenCompany(companyTaxId)
    const task = await this.newTask({ ...body, companyTaxId }, actor.username)
    await this.repository.createTask(task, this.change(task.createdAt, actor.username, "Task", task.id, "create", {}, this.taskView(task)))
    return task
  }

  async updateTask(id: string, body: TaskBody, actor: Actor): Promise<Task> {
    const task = await this.requireChangeableTask(id, actor)
    if (task.status !== "open") this.fail("task_not_open")
    const at = this.now().toISOString()
    const updated: Task = {
      ...task,
      description: body.description === undefined ? task.description : this.description(body.description),
      dueDate: body.dueDate === undefined ? task.dueDate : this.calendarDate(body.dueDate),
      assignee: body.assignee === undefined ? task.assignee : await this.requireUser(body.assignee),
      contactIds: body.contactIds === undefined ? task.contactIds : await this.requireContacts(task.companyTaxId, body.contactIds),
    }
    let operation: ChangeOperation = "update"
    if (body.status !== undefined) {
      const cancelReason = this.text(body.cancelReason)
      const reason = taskStatusRejection(task, body.status, cancelReason)
      if (reason) this.fail(reason)
      updated.status = body.status as Task["status"]
      updated.closedAt = at
      updated.cancelReason = updated.status === "cancelled" ? cancelReason : null
      operation = updated.status === "done" ? "complete" : "cancel"
    }
    const diff = changedFields(this.taskView(task), this.taskView(updated))
    await this.repository.updateTask(updated, this.change(at, actor.username, "Task", id, operation, diff.before, diff.after))
    return updated
  }

  async archiveTask(id: string, actor: Actor): Promise<Task> {
    const task = await this.requireChangeableTask(id, actor)
    if (task.archivedAt !== null) this.fail("already_archived")
    const at = this.now().toISOString()
    const archived = { ...task, archivedAt: at }
    await this.repository.updateTask(archived, this.change(at, actor.username, "Task", id, "archive", { archivedAt: null }, { archivedAt: at }))
    return archived
  }

  async restoreTask(id: string, actor: Actor): Promise<Task> {
    const task = await this.requireChangeableTask(id, actor)
    if (task.archivedAt === null) this.fail("not_archived")
    const at = this.now().toISOString()
    const restored = { ...task, archivedAt: null }
    await this.repository.updateTask(
      restored,
      this.change(at, actor.username, "Task", id, "restore", { archivedAt: task.archivedAt }, { archivedAt: null })
    )
    return restored
  }

  async agenda(query: AgendaQuery, actor: Actor): Promise<AgendaItem[]> {
    const assignee = query.assignee === "all" ? null : !query.assignee || query.assignee === "me" ? actor.username : query.assignee
    const today = todayInBuenosAires(this.now())
    const items = (await this.repository.listAgenda(assignee)).map((item) => ({ ...item, overdue: isOverdue(item.dueDate, today) }))
    return sortAgenda(query.overdueOnly === "true" ? items.filter((item) => item.overdue) : items)
  }

  async changes(entityType: unknown, entityId: unknown): Promise<Change[]> {
    if (!isChangeEntityType(entityType)) this.fail("invalid_entity")
    if (typeof entityId !== "string" || entityId === "") this.fail("invalid_entity")
    return this.repository.listChanges(entityType, entityId)
  }

  private async newTask(body: TaskBody & { companyTaxId: string }, createdBy: string): Promise<Task> {
    return {
      id: this.newId(),
      companyTaxId: body.companyTaxId,
      description: this.description(body.description),
      dueDate: this.calendarDate(body.dueDate),
      status: "open",
      cancelReason: null,
      assignee: body.assignee === undefined || body.assignee === null || body.assignee === "" ? createdBy : await this.requireUser(body.assignee),
      createdBy,
      contactIds: await this.requireContacts(body.companyTaxId, body.contactIds),
      createdAt: this.now().toISOString(),
      closedAt: null,
      archivedAt: null,
    }
  }

  private async addPerson(taxId: string, businessName: string, at: string, by: string): Promise<void> {
    await this.repository.addToCrm(
      {
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

  private actionView(action: Action): Record<string, unknown> {
    return {
      companyTaxId: action.companyTaxId,
      date: action.date,
      description: action.description,
      contactIds: action.contactIds,
      completedTaskIds: action.completedTaskIds,
      createdTaskId: action.createdTaskId,
    }
  }

  private taskView(task: Task): Record<string, unknown> {
    return {
      companyTaxId: task.companyTaxId,
      description: task.description,
      dueDate: task.dueDate,
      assignee: task.assignee,
      contactIds: task.contactIds,
      status: task.status,
      cancelReason: task.cancelReason,
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

  private async requireOpenCompany(taxId: string): Promise<CrmCompany> {
    const company = await this.requireCompany(taxId)
    if (company.closedAt !== null) this.fail("company_closed")
    return company
  }

  private async requireContact(id: string): Promise<Contact> {
    const contact = isValidCrmId(id) ? await this.repository.findContact(id) : null
    if (!contact) this.fail("contact_not_found")
    return contact
  }

  private async requireContacts(companyTaxId: string, value: unknown): Promise<string[]> {
    const ids = uniqueIds(value)
    if (ids === null) this.fail("contact_not_found")
    if (ids.length === 0) return []
    const found = await this.repository.contactsAtCompany(companyTaxId, ids)
    if (found.length !== ids.length) this.fail("contact_not_found")
    return ids
  }

  private async requireOpenTaskOf(id: string, companyTaxId: string): Promise<Task> {
    const task = await this.repository.findTask(id)
    if (!task || task.archivedAt !== null) this.fail("task_not_found")
    if (task.companyTaxId !== companyTaxId) this.fail("task_other_company")
    if (task.status !== "open") this.fail("task_not_open")
    return task
  }

  private async requireChangeableAction(id: string, actor: Actor): Promise<Action> {
    const action = isValidCrmId(id) ? await this.repository.findAction(id) : null
    if (!action) this.fail("action_not_found")
    if (!canChangeAction(actor, action)) this.fail("forbidden")
    return action
  }

  private async requireChangeableTask(id: string, actor: Actor): Promise<Task> {
    const task = isValidCrmId(id) ? await this.repository.findTask(id) : null
    if (!task) this.fail("task_not_found")
    if (!canChangeTask(actor, task)) this.fail("forbidden")
    return task
  }

  private async requireUser(value: unknown): Promise<string> {
    const username = cleanText(value)
    const users = (await this.repository.listActiveUsers()).map((user) => user.username)
    const match = username === null ? undefined : users.find((user) => user.toLowerCase() === username.toLowerCase())
    if (!match) this.fail("user_not_found")
    return match
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

  private calendarDate(value: unknown): string {
    if (!isValidCalendarDate(value)) this.fail("invalid_date")
    return value
  }

  private description(value: unknown): string {
    const description = this.text(value)
    if (description === null) this.fail("description_required")
    return description
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

  private text(value: unknown): string | null {
    const text = cleanText(value)
    if (isTooLong(text, MAX_TEXT_LENGTH)) this.fail("text_too_long")
    return text
  }

  private fail(reason: CrmRejection): never {
    throw new CrmError(reason, MESSAGES[reason])
  }
}
