import neo4j, { type ManagedTransaction, type Session } from "neo4j-driver"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import type { CrmCuitAdd, ICrmRepository } from "@ports/interfaces.js"
import { usernameKey } from "@domain/users.js"
import {
  COMPANY_REMOVED_REASON,
  CRM_SOURCE_NAME,
  type Action,
  type AgendaItem,
  type Task,
  type Change,
  type ChangeEntityType,
  type ChangeOperation,
  type Contact,
  type CrmCompany,
  type CrmCompanyFields,
  type CrmCuitState,
  type RemovalFacts,
  type RemovalOutcome,
} from "@domain/crm.js"

const ENTITY_LABELS: Record<ChangeEntityType, string> = {
  Action: "Action",
  Task: "Task",
  Contact: "Contact",
  CrmCompany: "CUIT",
  User: "User",
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function toNullableText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function toNumber(value: unknown): number {
  if (neo4j.isInt(value)) return value.toNumber()
  return typeof value === "number" ? value : 0
}

function toJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(toText(value))
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function toCompany(record: { get(key: string): unknown }): CrmCompany {
  return {
    taxId: toText(record.get("taxId")),
    businessName: toText(record.get("businessName")),
    crmBrand: toNullableText(record.get("crmBrand")),
    crmProduct: toNullableText(record.get("crmProduct")),
    crmOrigin: toNullableText(record.get("crmOrigin")),
    nosisPending: record.get("nosisPending") === true,
    addedAt: toNullableText(record.get("addedAt")),
    addedBy: toNullableText(record.get("addedBy")),
    lastActionDate: toNullableText(record.get("lastActionDate")),
    nextDueDate: toNullableText(record.get("nextDueDate")),
    openTaskCount: toNumber(record.get("openTaskCount")),
  }
}

function toContact(record: { get(key: string): unknown }): Contact {
  const properties = (record.get("k") as { properties: Record<string, unknown> }).properties
  return {
    id: toText(properties["id"]),
    fullName: toText(properties["fullName"]),
    phone: toNullableText(properties["phone"]),
    email: toNullableText(properties["email"]),
    birthday: toNullableText(properties["birthday"]),
    cuil: toNullableText(record.get("cuil")),
    companyTaxIds: (record.get("companyTaxIds") as unknown[]).map(toText),
    createdAt: toText(properties["createdAt"]),
    archivedAt: toNullableText(properties["archivedAt"]),
  }
}

function properties(record: { get(key: string): unknown }, key: string): Record<string, unknown> {
  return (record.get(key) as { properties: Record<string, unknown> }).properties
}

function toIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(toText) : []
}

function toAction(record: { get(key: string): unknown }): Action {
  const action = properties(record, "a")
  return {
    id: toText(action["id"]),
    companyTaxId: toText(record.get("companyTaxId")),
    date: toText(action["date"]),
    description: toText(action["description"]),
    doneBy: toText(record.get("doneBy")),
    contactIds: toIds(record.get("contactIds")),
    createdTaskId: toNullableText(record.get("createdTaskId")),
    completedTaskIds: toIds(record.get("completedTaskIds")),
    createdAt: toText(action["createdAt"]),
    archivedAt: toNullableText(action["archivedAt"]),
  }
}

function toTask(record: { get(key: string): unknown }): Task {
  const task = properties(record, "t")
  const status = task["status"]
  return {
    id: toText(task["id"]),
    companyTaxId: toText(record.get("companyTaxId")),
    description: toText(task["description"]),
    dueDate: toText(task["dueDate"]),
    status: status === "done" || status === "cancelled" ? status : "open",
    cancelReason: toNullableText(task["cancelReason"]),
    assignee: toText(record.get("assignee")),
    createdBy: toText(task["createdBy"]),
    contactIds: toIds(record.get("contactIds")),
    createdAt: toText(task["createdAt"]),
    closedAt: toNullableText(task["closedAt"]),
    archivedAt: toNullableText(task["archivedAt"]),
  }
}

function taskParams(task: Task): Record<string, unknown> {
  return { ...task, assigneeKey: usernameKey(task.assignee) }
}

function toChange(properties: Record<string, unknown>): Change {
  return {
    id: toText(properties["id"]),
    at: toText(properties["at"]),
    by: toText(properties["by"]),
    entityType: toText(properties["entityType"]) as ChangeEntityType,
    entityId: toText(properties["entityId"]),
    operation: toText(properties["operation"]) as ChangeOperation,
    before: toJsonObject(properties["before"]),
    after: toJsonObject(properties["after"]),
  }
}

export async function writeChange(tx: ManagedTransaction, change: Change): Promise<void> {
  await tx.run(Queries.CRM_WRITE_CHANGE, {
    ...change,
    byKey: usernameKey(change.by),
    before: JSON.stringify(change.before),
    after: JSON.stringify(change.after),
  })
  await tx.run(
    `MATCH (ch:Change {id: $id})
     MATCH (e:${ENTITY_LABELS[change.entityType]} {${change.entityType === "User" ? "usernameKey" : "id"}: $entityId})
     CREATE (ch)-[:CHANGED]->(e)`,
    { id: change.id, entityId: change.entityType === "User" ? usernameKey(change.entityId) : change.entityId }
  )
}

export class Neo4jCrmRepository implements ICrmRepository {
  private session(): Session {
    return Neo4jDriver.instance.session()
  }

  private async read<T>(work: (session: Session) => Promise<T>): Promise<T> {
    const session = this.session()
    try {
      return await work(session)
    } finally {
      await session.close()
    }
  }

  private async write(work: (tx: ManagedTransaction) => Promise<void>): Promise<void> {
    const session = this.session()
    try {
      await session.executeWrite(work)
    } finally {
      await session.close()
    }
  }

  async ensureSetup(): Promise<void> {
    await this.read(async (session) => {
      await session.run(Queries.CRM_ENSURE_SOURCE, { sourceName: CRM_SOURCE_NAME })
      await session.run(Queries.CRM_CONTACT_CONSTRAINT)
      await session.run(Queries.CRM_CHANGE_CONSTRAINT)
      await session.run(Queries.CRM_CHANGE_ENTITY_INDEX)
      await session.run(Queries.CRM_ACTION_CONSTRAINT)
      await session.run(Queries.CRM_TASK_CONSTRAINT)
      await session.run(Queries.CRM_TASK_DUE_DATE_INDEX)
    })
  }

  listActiveUsernames(): Promise<string[]> {
    return this.read(async (session) => {
      const result = await session.run(Queries.CRM_LIST_ACTIVE_USERNAMES)
      return result.records.map((record) => toText(record.get("username")))
    })
  }

  contactsAtCompany(taxId: string, contactIds: string[]): Promise<string[]> {
    return this.read(async (session) => {
      const result = await session.run(Queries.CRM_CONTACTS_AT_COMPANY, { taxId, contactIds })
      return result.records.map((record) => toText(record.get("id")))
    })
  }

  findAction(id: string): Promise<Action | null> {
    return this.read(async (session) => {
      const record = (await session.run(Queries.CRM_FIND_ACTION, { id })).records[0]
      return record ? toAction(record) : null
    })
  }

  findTask(id: string): Promise<Task | null> {
    return this.read(async (session) => {
      const record = (await session.run(Queries.CRM_FIND_TASK, { id })).records[0]
      return record ? toTask(record) : null
    })
  }

  recordAction(action: Action, closedTasks: Task[], nextTask: Task | null, changes: Change[]): Promise<void> {
    return this.write(async (tx) => {
      await tx.run(Queries.CRM_CREATE_ACTION, { ...action, doneByKey: usernameKey(action.doneBy) })
      for (const task of closedTasks) await tx.run(Queries.CRM_SET_TASK, taskParams(task))
      if (nextTask) await tx.run(Queries.CRM_CREATE_TASK, taskParams(nextTask))
      await tx.run(Queries.CRM_LINK_ACTION_TASKS, action)
      for (const change of changes) await writeChange(tx, change)
    })
  }

  updateAction(action: Action, change: Change): Promise<void> {
    return this.write(async (tx) => {
      await tx.run(Queries.CRM_SET_ACTION, action)
      await writeChange(tx, change)
    })
  }

  createTask(task: Task, change: Change): Promise<void> {
    return this.write(async (tx) => {
      await tx.run(Queries.CRM_CREATE_TASK, taskParams(task))
      await writeChange(tx, change)
    })
  }

  updateTask(task: Task, change: Change): Promise<void> {
    return this.write(async (tx) => {
      await tx.run(Queries.CRM_SET_TASK, taskParams(task))
      await writeChange(tx, change)
    })
  }

  listActions(taxId: string): Promise<Action[]> {
    return this.read(async (session) => {
      const result = await session.run(Queries.CRM_LIST_ACTIONS, { taxId })
      return result.records.map(toAction)
    })
  }

  listTasks(taxId: string): Promise<Task[]> {
    return this.read(async (session) => {
      const result = await session.run(Queries.CRM_LIST_TASKS, { taxId })
      return result.records.map(toTask)
    })
  }

  listAgenda(assignee: string | null): Promise<Omit<AgendaItem, "overdue">[]> {
    return this.read(async (session) => {
      const result = await session.run(Queries.CRM_LIST_AGENDA, { assigneeKey: assignee === null ? null : usernameKey(assignee) })
      return result.records.map((record) => ({ ...toTask(record), businessName: toText(record.get("businessName")) }))
    })
  }

  findCuitState(taxId: string): Promise<CrmCuitState> {
    return this.read(async (session) => {
      const record = (await session.run(Queries.CRM_FIND_CUIT_STATE, { taxId, sourceName: CRM_SOURCE_NAME })).records[0]!
      return {
        exists: record.get("exists") === true,
        inCrm: record.get("inCrm") === true,
        archived: record.get("archived") === true,
        nosisSearched: record.get("nosisSearched") === true,
        inKnownSource: record.get("inKnownSource") === true,
      }
    })
  }

  addToCrm(add: CrmCuitAdd, change: Change): Promise<void> {
    return this.write(async (tx) => {
      await tx.run(Queries.CRM_ADD_TO_SOURCE, { ...add, sourceName: CRM_SOURCE_NAME })
      await writeChange(tx, change)
    })
  }

  listCompanies(): Promise<CrmCompany[]> {
    return this.read(async (session) => {
      const result = await session.run(Queries.CRM_LIST_COMPANIES, { sourceName: CRM_SOURCE_NAME, taxId: null })
      return result.records.map(toCompany)
    })
  }

  findCompany(taxId: string): Promise<CrmCompany | null> {
    return this.read(async (session) => {
      const record = (await session.run(Queries.CRM_LIST_COMPANIES, { sourceName: CRM_SOURCE_NAME, taxId })).records[0]
      return record ? toCompany(record) : null
    })
  }

  updateCompany(taxId: string, fields: CrmCompanyFields, change: Change): Promise<void> {
    return this.write(async (tx) => {
      await tx.run(Queries.CRM_UPDATE_COMPANY, { taxId, ...fields })
      await writeChange(tx, change)
    })
  }

  findRemovalFacts(taxId: string): Promise<RemovalFacts> {
    return this.read(async (session) => {
      const record = (await session.run(Queries.CRM_FIND_REMOVAL_FACTS, { taxId, sourceName: CRM_SOURCE_NAME })).records[0]
      return {
        hasHistory: record?.get("hasHistory") === true,
        hasOtherSource: record?.get("hasOtherSource") === true,
        relatedToBase: record?.get("relatedToBase") === true,
        openTaskIds: ((record?.get("openTaskIds") as unknown[] | undefined) ?? []).map(toText),
      }
    })
  }

  removeCompany(taxId: string, outcome: RemovalOutcome, at: string, changes: Change[]): Promise<void> {
    return this.write(async (tx) => {
      for (const change of changes) await writeChange(tx, change)
      if (outcome === "archived") {
        await tx.run(Queries.CRM_CANCEL_OPEN_TASKS, { taxId, cancelReason: COMPANY_REMOVED_REASON, at })
      }
      await tx.run(Queries.CRM_UNLINK_COMPANY, { taxId, sourceName: CRM_SOURCE_NAME, archive: outcome === "archived", at })
      if (outcome === "deleted") await tx.run(Queries.CRM_DELETE_COMPANY, { taxId })
    })
  }

  companiesInCrm(taxIds: string[]): Promise<string[]> {
    return this.read(async (session) => {
      const result = await session.run(Queries.CRM_COMPANIES_IN_CRM, { taxIds, sourceName: CRM_SOURCE_NAME })
      return result.records.map((record) => toText(record.get("taxId")))
    })
  }

  createContact(contact: Contact, change: Change): Promise<void> {
    return this.write(async (tx) => {
      await tx.run(Queries.CRM_CREATE_CONTACT, contact)
      await tx.run(Queries.CRM_LINK_CONTACT, contact)
      await writeChange(tx, change)
    })
  }

  findContact(id: string): Promise<Contact | null> {
    return this.read(async (session) => {
      const record = (await session.run(Queries.CRM_FIND_CONTACT, { id })).records[0]
      return record ? toContact(record) : null
    })
  }

  updateContact(contact: Contact, change: Change): Promise<void> {
    return this.write(async (tx) => {
      await tx.run(Queries.CRM_UPDATE_CONTACT, contact)
      await tx.run(Queries.CRM_LINK_CONTACT, contact)
      await writeChange(tx, change)
    })
  }

  listContacts(taxId: string): Promise<Contact[]> {
    return this.read(async (session) => {
      const result = await session.run(Queries.CRM_LIST_CONTACTS, { taxId })
      return result.records.map(toContact)
    })
  }

  listChanges(entityType: ChangeEntityType, entityId: string): Promise<Change[]> {
    return this.read(async (session) => {
      const result = await session.run(Queries.CRM_LIST_CHANGES, { entityType, entityId })
      return result.records.map((record) => toChange((record.get("ch") as { properties: Record<string, unknown> }).properties))
    })
  }
}
