import { ownResponsible, responsiblesOf, sameResponsible, type Responsible } from "@domain/responsibles.js"
import {
  canChangeAction,
  canChangeTask,
  changedFields,
  cleanText,
  isOverdue,
  isValidCalendarDate,
  isValidCrmId,
  sortAgenda,
  taskStatusRejection,
  CompanyClosedError,
  TaskChangedError,
  TaskNoLongerOpenError,
  todayInBuenosAires,
  uniqueIds,
  type Action,
  type Actor,
  type AgendaItem,
  type ChangeOperation,
  type CrmCompany,
  type Task,
} from "@domain/crm.js"
import { CrmServiceBase, type ActionBody, type ActionResult, type AgendaQuery, type TaskBody } from "@application/CrmServiceBase.js"

/** Actions, tasks and the agenda. */
export class CrmWorkService extends CrmServiceBase {
  recordAction(body: ActionBody, actor: Actor): Promise<ActionResult> {
    return this.record(body, actor, true)
  }

  importAction(body: ActionBody, actor: Actor): Promise<ActionResult> {
    return this.record(body, actor, false)
  }

  protected async record(body: ActionBody, actor: Actor, requiresNextTask: boolean): Promise<ActionResult> {
    const companyTaxId = this.requireCuit(body.companyTaxId)
    await this.requireOpenCompany(companyTaxId)
    const responsibles = await this.repository.listResponsibles()
    const doneBy = this.responsibleFor(responsibles, body.doneBy, actor.username)
    const date = this.calendarDate(body.date)
    const description = this.description(body.description)
    const contactIds = await this.requireContacts(companyTaxId, body.contactIds)
    const completesTaskIds = uniqueIds(body.completesTaskIds)
    if (completesTaskIds === null) this.fail("task_not_found")
    const toClose = await Promise.all(completesTaskIds.map((id) => this.requireOpenTaskOf(id, companyTaxId)))
    if (!body.nextTask && requiresNextTask) this.fail("next_task_required")
    const nextTask = body.nextTask ? await this.newTask({ ...body.nextTask, companyTaxId }, actor.username, responsibles) : null

    const at = this.now().toISOString()
    const action: Action = {
      id: this.newId(),
      companyTaxId,
      date,
      description,
      doneBy,
      recordedBy: actor.username,
      contactIds,
      createdTaskId: nextTask?.id ?? null,
      completedTaskIds: completesTaskIds,
      createdAt: at,
      archivedAt: null,
    }
    const closedTasks = toClose.map((task) => ({ ...task, status: "done" as const, closedAt: at }))
    await this.guarded(() => this.repository.recordAction(action, closedTasks, nextTask && { ...nextTask, createdAt: at }, [
      this.change(at, actor.username, "Action", action.id, "create", {}, this.actionView(action)),
      ...closedTasks.map((task) =>
        this.change(at, actor.username, "Task", task.id, "complete", { status: "open" }, { status: "done", byAction: action.id })
      ),
      ...(nextTask ? [this.change(at, actor.username, "Task", nextTask.id, "create", {}, this.taskView(nextTask))] : []),
    ]))
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
    const task = await this.newTask({ ...body, companyTaxId }, actor.username, await this.repository.listResponsibles())
    await this.guarded(() =>
      this.repository.createTask(task, this.change(task.createdAt, actor.username, "Task", task.id, "create", {}, this.taskView(task)))
    )
    return task
  }

  async updateTask(id: string, body: TaskBody, actor: Actor): Promise<Task> {
    const task = await this.requireChangeableTask(id, actor)
    if (task.status !== "open") this.fail("task_not_open")
    await this.requireOpenCompany(task.companyTaxId)
    const at = this.now().toISOString()
    const keepsAssignee = body.assignee === undefined || (typeof body.assignee === "string" && sameResponsible(body.assignee, task.assignee))
    const updated: Task = {
      ...task,
      description: body.description === undefined ? task.description : this.description(body.description),
      dueDate: body.dueDate === undefined ? task.dueDate : this.calendarDate(body.dueDate),
      assignee: keepsAssignee ? task.assignee : this.responsibleFor(await this.repository.listResponsibles(), body.assignee, null),
      contactIds: body.contactIds === undefined ? task.contactIds : await this.requireTaskContacts(task, body.contactIds),
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
    await this.guarded(() =>
      this.repository.updateTask(updated, this.change(at, actor.username, "Task", id, operation, diff.before, diff.after), task)
    )
    return updated
  }

  async archiveTask(id: string, actor: Actor): Promise<Task> {
    const task = await this.requireChangeableTask(id, actor)
    if (task.archivedAt !== null) this.fail("already_archived")
    const at = this.now().toISOString()
    const archived = { ...task, archivedAt: at }
    await this.guarded(() =>
      this.repository.updateTask(archived, this.change(at, actor.username, "Task", id, "archive", { archivedAt: null }, { archivedAt: at }), task)
    )
    return archived
  }

  async restoreTask(id: string, actor: Actor): Promise<Task> {
    const task = await this.requireChangeableTask(id, actor)
    if (task.archivedAt === null) this.fail("not_archived")
    if (task.status === "open") await this.requireOpenCompany(task.companyTaxId)
    const at = this.now().toISOString()
    const restored = { ...task, archivedAt: null }
    await this.guarded(() =>
      this.repository.updateTask(
        restored,
        this.change(at, actor.username, "Task", id, "restore", { archivedAt: task.archivedAt }, { archivedAt: null }),
        task
      )
    )
    return restored
  }

  async agenda(query: AgendaQuery, actor: Actor): Promise<AgendaItem[]> {
    const assignees =
      query.assignee === "all"
        ? null
        : !query.assignee || query.assignee === "me"
          ? responsiblesOf(await this.repository.listResponsibles(), actor.username)
          : [query.assignee]
    const today = todayInBuenosAires(this.now())
    const items = (await this.repository.listAgenda(assignees)).map((item) => ({ ...item, overdue: isOverdue(item.dueDate, today) }))
    return sortAgenda(query.overdueOnly === "true" ? items.filter((item) => item.overdue) : items)
  }

  private async newTask(body: TaskBody & { companyTaxId: string }, createdBy: string, responsibles: readonly Responsible[]): Promise<Task> {
    return {
      id: this.newId(),
      companyTaxId: body.companyTaxId,
      description: this.description(body.description),
      dueDate: this.calendarDate(body.dueDate),
      status: "open",
      cancelReason: null,
      assignee: this.responsibleFor(responsibles, body.assignee, createdBy),
      createdBy,
      contactIds: await this.requireContacts(body.companyTaxId, body.contactIds),
      createdAt: this.now().toISOString(),
      closedAt: null,
      archivedAt: null,
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

  private async requireOpenCompany(taxId: string): Promise<CrmCompany> {
    const company = await this.requireCompany(taxId)
    if (company.closedAt !== null) this.fail("company_closed")
    return company
  }

  private async requireContacts(companyTaxId: string, value: unknown): Promise<string[]> {
    const ids = uniqueIds(value)
    if (ids === null) this.fail("contact_not_found")
    if (ids.length === 0) return []
    const found = await this.repository.contactsAtCompany(companyTaxId, ids)
    if (found.length !== ids.length) this.fail("contact_not_found")
    return ids
  }

  private async requireTaskContacts(task: Task, value: unknown): Promise<string[]> {
    const ids = uniqueIds(value)
    if (ids === null) this.fail("contact_not_found")
    const kept = ids.filter((id) => task.contactIds.includes(id))
    const added = await this.requireContacts(task.companyTaxId, ids.filter((id) => !task.contactIds.includes(id)))
    return [...kept, ...added]
  }

  private async guarded(write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (err) {
      if (err instanceof TaskNoLongerOpenError) this.fail("task_not_open")
      if (err instanceof TaskChangedError) this.fail("task_changed")
      if (err instanceof CompanyClosedError) this.fail("company_closed")
      throw err
    }
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
    if (!canChangeAction(await this.withResponsibles(actor), action)) this.fail("forbidden")
    return action
  }

  private async requireChangeableTask(id: string, actor: Actor): Promise<Task> {
    const task = isValidCrmId(id) ? await this.repository.findTask(id) : null
    if (!task) this.fail("task_not_found")
    if (!canChangeTask(await this.withResponsibles(actor), task)) this.fail("forbidden")
    return task
  }

  private async withResponsibles(actor: Actor): Promise<Actor> {
    if (actor.canAdminister) return actor
    return { ...actor, responsibles: responsiblesOf(await this.repository.listResponsibles(), actor.username) }
  }

  private responsibleFor(responsibles: readonly Responsible[], value: unknown, fallbackUser: string | null): string {
    const name = cleanText(value)
    if (name === null) {
      const own = fallbackUser === null ? null : ownResponsible(responsibles, fallbackUser)
      if (own === null) this.fail("responsible_required")
      return own
    }
    const match = responsibles.find((responsible) => !responsible.disabled && sameResponsible(responsible.name, name))
    if (!match) this.fail("responsible_not_found")
    return match.name
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
}
