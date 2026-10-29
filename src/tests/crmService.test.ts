import { describe, it, expect, beforeEach } from "vitest"
import { CrmService, CrmError } from "@application/CrmService"
import { InMemoryCrmRepository } from "./crmFakes"

const NOW = new Date("2026-10-29T15:00:00.000Z")
const COMPANY = "30712345678"
const OTHER = "30798765432"
const PERSON = "20301234567"

let repository: InMemoryCrmRepository
let service: CrmService
let nextId: number

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
}

async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (err) {
    if (err instanceof CrmError) return err.reason
    throw err
  }
  throw new Error("expected a rejection")
}

beforeEach(() => {
  repository = new InMemoryCrmRepository()
  nextId = 0
  service = new CrmService(repository, () => NOW, () => id(++nextId))
})

describe("adding a company", () => {
  it("creates a CUIT the graph does not have, off the Nosis queue while it is in no known source", async () => {
    const result = await service.addCompany({ taxId: COMPANY, businessName: " ACME SA ", crmBrand: "Acme" }, "santi")
    expect(result).toEqual({ taxId: COMPANY, created: true, restored: false, nosisPending: false })
    expect(repository.cuits.get(COMPANY)).toMatchObject({ businessName: "ACME SA", company: true, addedBy: "santi" })
    expect(repository.changes[0]).toMatchObject({
      entityType: "CrmCompany",
      entityId: COMPANY,
      operation: "crm_add",
      by: "santi",
      at: NOW.toISOString(),
    })
  })

  it("needs a business name for a CUIT the graph does not have", async () => {
    expect(await rejection(service.addCompany({ taxId: COMPANY }, "santi"))).toBe("business_name_required")
  })

  it("queues it for Nosis when its origin is a known source", async () => {
    expect(await service.addCompany({ taxId: COMPANY, businessName: "ACME", originSource: "Poseidon" }, "santi")).toMatchObject({
      nosisPending: true,
    })
    expect((await service.listCompanies())[0]?.nosisPending).toBe(true)
  })

  it("does not queue it when its origin is a source of people to know", async () => {
    expect(await service.addCompany({ taxId: COMPANY, businessName: "ACME", originSource: "Bolsa" }, "santi")).toMatchObject({
      nosisPending: false,
    })
  })

  it("takes an existing CUIT without a name and keeps it off the Nosis queue when a known source has it", async () => {
    repository.seedCuit(COMPANY, { knownSources: ["Poseidon"] })
    expect(await service.addCompany({ taxId: COMPANY }, "santi")).toMatchObject({ created: false, nosisPending: false })
  })

  it("refuses a malformed CUIT", async () => {
    expect(await rejection(service.addCompany({ taxId: "30-71234567-8", businessName: "x" }, "santi"))).toBe("invalid_cuit")
  })

  it("refuses one already in the CRM", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME" }, "santi")
    expect(await rejection(service.addCompany({ taxId: COMPANY }, "santi"))).toBe("already_in_crm")
  })

  it("restores an archived company", async () => {
    repository.seedCuit(COMPANY, { archivedAt: "2026-01-01T00:00:00.000Z", nosisSearched: true })
    expect(await service.addCompany({ taxId: COMPANY }, "santi")).toMatchObject({ restored: true })
    expect(repository.cuits.get(COMPANY)?.archivedAt).toBeNull()
  })

  it("refuses a name longer than the limit", async () => {
    expect(await rejection(service.addCompany({ taxId: COMPANY, businessName: "x".repeat(201) }, "santi"))).toBe("text_too_long")
  })
})

describe("company data", () => {
  beforeEach(async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME", crmBrand: "Acme" }, "santi")
  })

  it("lists the companies and shows one with its contacts", async () => {
    expect(await service.listCompanies()).toHaveLength(1)
    expect(await service.companyDetail(COMPANY)).toMatchObject({
      company: { taxId: COMPANY, crmBrand: "Acme" },
      contacts: [],
      actions: [],
      tasks: [],
    })
  })

  it("says when a company is not in the CRM", async () => {
    expect(await rejection(service.companyDetail(OTHER))).toBe("company_not_in_crm")
  })

  it("records only what changed", async () => {
    const company = await service.updateCompany(COMPANY, { crmBrand: "Acme", crmProduct: "Seguros" }, "flavia")
    expect(company).toMatchObject({ crmBrand: "Acme", crmProduct: "Seguros", crmOrigin: null })
    expect(repository.changes.at(-1)).toMatchObject({
      operation: "update",
      by: "flavia",
      before: { crmProduct: null },
      after: { crmProduct: "Seguros" },
    })
  })
})

describe("removing a company", () => {
  beforeEach(async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME" }, "santi")
  })

  it("previews without writing", async () => {
    expect(await service.removeCompany(COMPANY, true, "santi")).toEqual({ outcome: "deleted", cancelledTaskCount: 0, dryRun: true })
    expect(repository.cuits.has(COMPANY)).toBe(true)
    expect(repository.changes).toHaveLength(1)
  })

  it("deletes one left with nothing", async () => {
    expect(await service.removeCompany(COMPANY, false, "santi")).toEqual({ outcome: "deleted", cancelledTaskCount: 0, dryRun: false })
    expect(repository.deleted).toEqual([COMPANY])
    expect(repository.changes.at(-1)).toMatchObject({ operation: "crm_remove", after: { outcome: "deleted" } })
  })

  it("archives one with contacts", async () => {
    await service.createContact({ fullName: "Ana", companyTaxIds: [COMPANY] }, "santi")
    expect(await service.removeCompany(COMPANY, false, "santi")).toMatchObject({ outcome: "archived" })
    expect(repository.cuits.get(COMPANY)?.archivedAt).toBe(NOW.toISOString())
  })

  it("only unlinks one a source holds, and keeps it in that source", async () => {
    repository.cuits.get(COMPANY)!.sources = ["Poseidon"]
    expect(await service.removeCompany(COMPANY, false, "santi")).toMatchObject({ outcome: "unlinked" })
    expect(repository.cuits.get(COMPANY)).toMatchObject({ company: false, sources: ["Poseidon"] })
  })

  it("says when it is not in the CRM", async () => {
    expect(await rejection(service.removeCompany(OTHER, false, "santi"))).toBe("company_not_in_crm")
  })
})

describe("contacts", () => {
  beforeEach(async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME" }, "santi")
    await service.addCompany({ taxId: OTHER, businessName: "OTRA" }, "santi")
  })

  it("creates one linked to its companies", async () => {
    const contact = await service.createContact(
      { fullName: " Ana Pérez ", companyTaxIds: [COMPANY, COMPANY, OTHER], phone: "11 5555", birthday: "06/05/1980" },
      "santi"
    )
    expect(contact).toMatchObject({ fullName: "Ana Pérez", companyTaxIds: [COMPANY, OTHER], birthday: "06/05/1980", cuil: null })
    expect(await service.companyDetail(OTHER)).toMatchObject({ contacts: [{ id: contact.id }] })
  })

  it("adds the CUIL to the CRM as a person, not as a company", async () => {
    const contact = await service.createContact({ fullName: "Ana", companyTaxIds: [COMPANY], cuil: PERSON }, "santi")
    expect(contact.cuil).toBe(PERSON)
    expect(repository.cuits.get(PERSON)).toMatchObject({ company: false, nosisPending: false, sources: [] })
    expect((await service.listCompanies()).map((company) => company.taxId)).not.toContain(PERSON)
  })

  it("validates every field", async () => {
    expect(await rejection(service.createContact({ fullName: " ", companyTaxIds: [COMPANY] }, "santi"))).toBe("full_name_required")
    expect(await rejection(service.createContact({ fullName: "Ana", companyTaxIds: [] }, "santi"))).toBe("company_required")
    expect(await rejection(service.createContact({ fullName: "Ana", companyTaxIds: ["x"] }, "santi"))).toBe("invalid_cuit")
    expect(await rejection(service.createContact({ fullName: "Ana", companyTaxIds: [PERSON] }, "santi"))).toBe("company_not_in_crm")
    expect(await rejection(service.createContact({ fullName: "Ana", companyTaxIds: [COMPANY], birthday: "31/02/1980" }, "santi"))).toBe(
      "invalid_date"
    )
    expect(await rejection(service.createContact({ fullName: "Ana", companyTaxIds: [COMPANY], cuil: "2-3" }, "santi"))).toBe("invalid_cuit")
  })

  it("updates only what it is sent and records the difference", async () => {
    const contact = await service.createContact({ fullName: "Ana", companyTaxIds: [COMPANY], email: "ana@acme.com" }, "santi")
    const updated = await service.updateContact(contact.id, { phone: "11 5555", companyTaxIds: [OTHER] }, "flavia")
    expect(updated).toMatchObject({ fullName: "Ana", email: "ana@acme.com", phone: "11 5555", companyTaxIds: [OTHER] })
    expect(repository.changes.at(-1)).toMatchObject({
      operation: "update",
      before: { phone: null, companyTaxIds: [COMPANY] },
      after: { phone: "11 5555", companyTaxIds: [OTHER] },
    })
  })

  it("sets a CUIL once and refuses to change it", async () => {
    const contact = await service.createContact({ fullName: "Ana", companyTaxIds: [COMPANY] }, "santi")
    expect((await service.updateContact(contact.id, { cuil: PERSON }, "santi")).cuil).toBe(PERSON)
    expect((await service.updateContact(contact.id, { cuil: PERSON }, "santi")).cuil).toBe(PERSON)
    expect(await rejection(service.updateContact(contact.id, { cuil: "20999999999" }, "santi"))).toBe("cuil_already_set")
  })

  it("archives and restores", async () => {
    const contact = await service.createContact({ fullName: "Ana", companyTaxIds: [COMPANY] }, "santi")
    expect((await service.archiveContact(contact.id, "santi")).archivedAt).toBe(NOW.toISOString())
    expect(await service.companyDetail(COMPANY)).toMatchObject({ contacts: [] })
    expect(await rejection(service.archiveContact(contact.id, "santi"))).toBe("already_archived")
    expect((await service.restoreContact(contact.id, "santi")).archivedAt).toBeNull()
    expect(await rejection(service.restoreContact(contact.id, "santi"))).toBe("not_archived")
    expect(repository.changes.slice(-2).map((change) => change.operation)).toEqual(["archive", "restore"])
  })

  it("says when a contact does not exist", async () => {
    expect(await rejection(service.updateContact(id(999), {}, "santi"))).toBe("contact_not_found")
    expect(await rejection(service.archiveContact("nope", "santi"))).toBe("contact_not_found")
  })
})

describe("actions and tasks", () => {
  const santi = { username: "santi", canAdminister: true }
  const flavia = { username: "flavia", canAdminister: false }
  const pedro = { username: "pedro", canAdminister: false }
  let anaId: string

  beforeEach(async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME" }, "santi")
    await service.addCompany({ taxId: OTHER, businessName: "OTRA" }, "santi")
    anaId = (await service.createContact({ fullName: "Ana", companyTaxIds: [COMPANY] }, "santi")).id
  })

  const NEXT = { description: "Seguir", dueDate: "2026-11-05" }

  async function openTask(actor = flavia, body: Record<string, unknown> = {}) {
    return service.createTask({ companyTaxId: COMPANY, description: "Llamar", dueDate: "2026-10-30", ...body }, actor)
  }

  it("records an action that closes a task and opens the next one, all in one write", async () => {
    const first = await openTask()
    const result = await service.recordAction(
      {
        companyTaxId: COMPANY,
        date: "2026-10-29",
        description: " Lo llamé, pidió propuesta ",
        contactIds: [anaId],
        completesTaskIds: [first.id],
        nextTask: { description: "Mandar propuesta", dueDate: "2026-11-02", assignee: "FLAVIA" },
      },
      flavia
    )
    expect(result.action).toMatchObject({
      description: "Lo llamé, pidió propuesta",
      doneBy: "Flavia",
      recordedBy: "flavia",
      contactIds: [anaId],
      completedTaskIds: [first.id],
      createdTaskId: result.nextTask?.id,
    })
    expect(result.closedTasks).toEqual([expect.objectContaining({ id: first.id, status: "done", closedAt: NOW.toISOString() })])
    expect(result.nextTask).toMatchObject({ assignee: "Flavia", createdBy: "flavia", status: "open", dueDate: "2026-11-02" })
    expect(repository.changes.slice(-3).map((change) => [change.entityType, change.operation])).toEqual([
      ["Action", "create"],
      ["Task", "complete"],
      ["Task", "create"],
    ])
  })

  it("assigns the next task to whoever records the action by default", async () => {
    const result = await service.recordAction(
      { companyTaxId: COMPANY, date: "2026-10-29", description: "x", nextTask: { description: "y", dueDate: "2026-11-02" } },
      pedro
    )
    expect(result.nextTask?.assignee).toBe("pedro")
  })

  it("validates the action", async () => {
    const base = { companyTaxId: COMPANY, date: "2026-10-29", description: "x" }
    expect(await rejection(service.recordAction({ ...base, date: "29/10/2026" }, flavia))).toBe("invalid_date")
    expect(await rejection(service.recordAction({ ...base, description: " " }, flavia))).toBe("description_required")
    expect(await rejection(service.recordAction({ ...base, description: "x".repeat(2001) }, flavia))).toBe("text_too_long")
    expect(await rejection(service.recordAction({ ...base, companyTaxId: PERSON }, flavia))).toBe("company_not_in_crm")
    expect(await rejection(service.recordAction({ ...base, contactIds: [id(999)] }, flavia))).toBe("contact_not_found")
    expect(await rejection(service.recordAction({ ...base, completesTaskIds: ["x"] }, flavia))).toBe("task_not_found")
    expect(await rejection(service.recordAction({ ...base, completesTaskIds: [id(999)] }, flavia))).toBe("task_not_found")
    expect(
      await rejection(service.recordAction({ ...base, nextTask: { description: "y", dueDate: "2026-11-02", assignee: "nadie" } }, flavia))
    ).toBe("responsible_not_found")
  })

  it("only closes open tasks of the same company", async () => {
    const other = await service.createTask({ companyTaxId: OTHER, description: "x", dueDate: "2026-10-30" }, flavia)
    const base = { companyTaxId: COMPANY, date: "2026-10-29", description: "x" }
    expect(await rejection(service.recordAction({ ...base, completesTaskIds: [other.id], nextTask: NEXT }, flavia))).toBe("task_other_company")
    const done = await openTask()
    await service.updateTask(done.id, { status: "cancelled", cancelReason: "x" }, flavia)
    expect(await rejection(service.recordAction({ ...base, completesTaskIds: [done.id], nextTask: NEXT }, flavia))).toBe("task_not_open")
  })

  it("lets members change only their own actions", async () => {
    const { action } = await service.recordAction({ companyTaxId: COMPANY, date: "2026-10-29", description: "x", nextTask: NEXT }, flavia)
    expect((await service.updateAction(action.id, { description: "y", date: "2026-10-28" }, flavia)).description).toBe("y")
    expect(await rejection(service.updateAction(action.id, { description: "z" }, pedro))).toBe("forbidden")
    expect((await service.updateAction(action.id, { contactIds: [anaId] }, santi)).contactIds).toEqual([anaId])
    expect(await rejection(service.updateAction(id(999), {}, santi))).toBe("action_not_found")
    expect(repository.changes.at(-1)).toMatchObject({ operation: "update", before: { contactIds: [] }, after: { contactIds: [anaId] } })
  })

  it("archives and restores an action", async () => {
    const { action } = await service.recordAction({ companyTaxId: COMPANY, date: "2026-10-29", description: "x", nextTask: NEXT }, flavia)
    await service.archiveAction(action.id, flavia)
    expect((await service.companyDetail(COMPANY)).actions).toEqual([])
    expect(await rejection(service.archiveAction(action.id, flavia))).toBe("already_archived")
    await service.restoreAction(action.id, flavia)
    expect(await rejection(service.restoreAction(action.id, flavia))).toBe("not_archived")
    expect((await service.companyDetail(COMPANY)).actions).toHaveLength(1)
  })

  it("lets the creator or the assignee change a task, and nobody else", async () => {
    const task = await openTask(santi, { assignee: "flavia" })
    expect((await service.updateTask(task.id, { dueDate: "2026-11-05", contactIds: [anaId] }, flavia)).dueDate).toBe("2026-11-05")
    expect(await rejection(service.updateTask(task.id, { description: "z" }, pedro))).toBe("forbidden")
    expect((await service.updateTask(task.id, { assignee: "pedro" }, santi)).assignee).toBe("pedro")
    expect(await rejection(service.updateTask(task.id, { assignee: "nadie" }, santi))).toBe("responsible_not_found")
  })

  it("cancels a task only with a reason and never twice", async () => {
    const task = await openTask()
    expect(await rejection(service.updateTask(task.id, { status: "cancelled" }, flavia))).toBe("cancel_reason_required")
    const cancelled = await service.updateTask(task.id, { status: "cancelled", cancelReason: "Ya no compra" }, flavia)
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Ya no compra", closedAt: NOW.toISOString() })
    expect(repository.changes.at(-1)?.operation).toBe("cancel")
    expect(await rejection(service.updateTask(task.id, { description: "x" }, flavia))).toBe("task_not_open")
    expect(await rejection(service.updateTask(id(999), {}, flavia))).toBe("task_not_found")
  })

  it("never marks a task done on its own", async () => {
    const task = await openTask()
    expect(await rejection(service.updateTask(task.id, { status: "done" }, flavia))).toBe("invalid_status")
    expect(await rejection(service.updateTask(task.id, { status: "open" }, flavia))).toBe("invalid_status")
    expect(repository.tasks.get(task.id)?.status).toBe("open")
  })

  it("needs every action to leave the next task", async () => {
    const base = { companyTaxId: COMPANY, date: "2026-10-29", description: "x" }
    expect(await rejection(service.recordAction(base, flavia))).toBe("next_task_required")
    expect(await rejection(service.recordAction({ ...base, nextTask: null }, flavia))).toBe("next_task_required")
  })

  it("lets the history import record a last action with no next task", async () => {
    const task = await openTask()
    const result = await service.importAction(
      { companyTaxId: COMPANY, date: "2026-10-29", description: "Cerró", completesTaskIds: [task.id], nextTask: null },
      santi
    )
    expect(result.nextTask).toBeNull()
    expect(repository.tasks.get(task.id)?.status).toBe("done")
  })

  it("never reopens a task an action completed while someone was editing it", async () => {
    const task = await openTask()
    const action = { companyTaxId: COMPANY, date: "2026-10-29", description: "x", completesTaskIds: [task.id], nextTask: NEXT }
    await Promise.allSettled([service.updateTask(task.id, { description: "Otra" }, flavia), service.recordAction(action, flavia)])
    expect(repository.tasks.get(task.id)?.status).toBe("done")
  })

  it("leaves no open task on a company closed while an action was being recorded", async () => {
    const action = { companyTaxId: COMPANY, date: "2026-10-29", description: "x", nextTask: NEXT }
    const [recorded] = await Promise.allSettled([service.recordAction(action, flavia), service.closeCompany(COMPANY, "No va", "santi")])
    const open = [...repository.tasks.values()].filter((task) => task.companyTaxId === COMPANY && task.status === "open")
    expect(open).toEqual([])
    if (recorded.status === "rejected") expect((recorded.reason as CrmError).reason).toBe("company_closed")
  })

  it("completes a task only once when two actions race for it", async () => {
    const task = await openTask()
    const body = { companyTaxId: COMPANY, date: "2026-10-29", description: "x", completesTaskIds: [task.id], nextTask: NEXT }
    const results = await Promise.allSettled([service.recordAction(body, flavia), service.recordAction(body, flavia)])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
    expect(((results[1] as PromiseRejectedResult).reason as CrmError).reason).toBe("task_not_open")
    expect(repository.actions.size).toBe(1)
  })

  it("edits a task whose responsible was disabled or whose contact was archived, as long as those stay", async () => {
    const task = await openTask(flavia, { contactIds: [anaId] })
    repository.responsibles = repository.responsibles.map((responsible) =>
      responsible.name === "Flavia" ? { ...responsible, disabled: true } : responsible
    )
    await service.archiveContact(anaId, "santi")
    const updated = await service.updateTask(task.id, { dueDate: "2026-11-09", assignee: "Flavia", contactIds: [anaId] }, santi)
    expect(updated).toMatchObject({ dueDate: "2026-11-09", assignee: "Flavia", contactIds: [anaId] })
    expect(await rejection(service.updateTask(task.id, { assignee: "Nadie" }, santi))).toBe("responsible_not_found")
  })

  it("archives and restores a task", async () => {
    const task = await openTask()
    await service.archiveTask(task.id, flavia)
    expect(await rejection(service.archiveTask(task.id, flavia))).toBe("already_archived")
    await service.restoreTask(task.id, flavia)
    expect(await rejection(service.restoreTask(task.id, flavia))).toBe("not_archived")
  })

  it("builds the agenda for me, someone else or everybody, flagging overdue in Buenos Aires time", async () => {
    await openTask(flavia, { dueDate: "2026-10-28" })
    await openTask(flavia, { dueDate: "2026-11-02" })
    await openTask(santi, { dueDate: "2026-10-29", assignee: "pedro" })

    const mine = await service.agenda({}, flavia)
    expect(mine.map((item) => [item.dueDate, item.overdue, item.businessName])).toEqual([
      ["2026-10-28", true, "ACME"],
      ["2026-11-02", false, "ACME"],
    ])
    expect(await service.agenda({ assignee: "pedro" }, flavia)).toHaveLength(1)
    expect(await service.agenda({ assignee: "all" }, flavia)).toHaveLength(3)
    expect(await service.agenda({ assignee: "all", overdueOnly: "true" }, flavia)).toHaveLength(2)
  })

  it("shows next to each task the action that left it, or the company's last one for a loose task", async () => {
    const { nextTask } = await service.recordAction(
      { companyTaxId: COMPANY, date: "2026-10-20", description: "Lo llamé", contactIds: [anaId], nextTask: { description: "Seguir", dueDate: "2026-11-02" } },
      flavia
    )
    const loose = await openTask(flavia, { dueDate: "2026-11-03" })
    const agenda = await service.agenda({}, flavia)
    expect(agenda.find((item) => item.id === nextTask!.id)?.lastAction).toEqual({
      date: "2026-10-20",
      description: "Lo llamé",
      doneBy: "Flavia",
      contacts: ["Ana"],
    })
    expect(agenda.find((item) => item.id === loose.id)?.lastAction?.description).toBe("Lo llamé")
  })

  it("cancels the open tasks of a company that is archived", async () => {
    const task = await openTask()
    expect(await service.removeCompany(COMPANY, true, "santi")).toEqual({ outcome: "archived", cancelledTaskCount: 1, dryRun: true })
    await service.removeCompany(COMPANY, false, "santi")
    expect(repository.tasks.get(task.id)).toMatchObject({ status: "cancelled", cancelReason: "company_removed" })
    expect(repository.changes.at(-1)).toMatchObject({ entityType: "Task", entityId: task.id, operation: "cancel" })
  })

  it("shows the history of an entity, newest first", async () => {
    const task = await openTask()
    await service.recordAction({ companyTaxId: COMPANY, date: "2026-10-29", description: "x", completesTaskIds: [task.id], nextTask: NEXT }, flavia)
    expect((await service.changes("Task", task.id)).map((change) => change.operation)).toEqual(["complete", "create"])
    expect(await rejection(service.changes("CUIT", task.id))).toBe("invalid_entity")
    expect(await rejection(service.changes("Task", ""))).toBe("invalid_entity")
  })

  it("lists the users a task can go to", async () => {
    repository.colors.set("Flavia", "teal")
    expect(await service.listUsers()).toEqual([
      { username: "santi", color: null },
      { username: "Flavia", color: "teal" },
      { username: "pedro", color: null },
    ])
  })
})

describe("origin and closing", () => {
  const flavia = { username: "flavia", canAdminister: false }
  const NEXT = { description: "Seguir", dueDate: "2026-11-05" }

  it("adds a company to the source picked as its origin, with no free text", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME", crmOrigin: "Amigo", originSource: "Poseidon" }, "santi")
    expect(repository.cuits.get(COMPANY)).toMatchObject({
      sources: ["Poseidon"],
      fields: { crmOrigin: null, originSource: "Poseidon" },
    })
  })

  it("keeps free text as origin without touching any source", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME", crmOrigin: "Amigo de Luchi" }, "santi")
    expect(repository.cuits.get(COMPANY)).toMatchObject({ sources: [], fields: { crmOrigin: "Amigo de Luchi", originSource: null } })
  })

  it("refuses a source that does not exist", async () => {
    expect(await rejection(service.addCompany({ taxId: COMPANY, businessName: "ACME", originSource: "Nada" }, "santi"))).toBe(
      "source_not_found"
    )
  })

  it("keeps a CUIT in a source it already had before the CRM, whatever the origin becomes", async () => {
    repository.seedCuit(COMPANY, { businessName: "ACME", sources: ["Bolsa"] })
    await service.addCompany({ taxId: COMPANY, originSource: "Bolsa" }, "santi")
    await service.updateCompany(COMPANY, { crmOrigin: "Conocido" }, "santi")
    expect(repository.cuits.get(COMPANY)?.sources).toEqual(["Bolsa"])
  })

  it("gives back the trust level a company had when it is reopened", async () => {
    repository.seedCuit(COMPANY, { businessName: "ACME", sources: ["Bolsa"], levelOfTrust: 3, trustReason: "Buen pagador" })
    await service.addCompany({ taxId: COMPANY }, "santi")
    expect((await service.closeCompany(COMPANY, "No va", "santi")).inservible).toBe(true)
    expect(repository.cuits.get(COMPANY)).toMatchObject({ levelOfTrust: 1, trustReason: "No va" })
    await service.reopenCompany(COMPANY, "santi")
    expect(repository.cuits.get(COMPANY)).toMatchObject({ levelOfTrust: 3, trustReason: "Buen pagador" })
  })

  it("takes the CUIT out of the source the CRM put it in when it leaves the CRM, and keeps sources it had before", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME", originSource: "Bolsa" }, "santi")
    expect((await service.removeCompany(COMPANY, false, "santi")).outcome).toBe("deleted")
    repository.seedCuit(OTHER, { businessName: "OTRA", sources: ["Bolsa"] })
    await service.addCompany({ taxId: OTHER, originSource: "Bolsa" }, "santi")
    expect((await service.removeCompany(OTHER, false, "santi")).outcome).toBe("unlinked")
    expect(repository.cuits.get(OTHER)?.sources).toEqual(["Bolsa"])
  })

  it("keeps the fields an edit does not send", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME", crmBrand: "Acme", crmProduct: "Seguros", originSource: "Poseidon" }, "santi")
    await service.updateCompany(COMPANY, { crmBrand: "Nueva" }, "santi")
    expect(repository.cuits.get(COMPANY)).toMatchObject({
      sources: ["Poseidon"],
      fields: { crmBrand: "Nueva", crmProduct: "Seguros", crmOrigin: null, originSource: "Poseidon" },
    })
  })

  it("brings back no open task nor edits one while the company is closed", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME" }, "santi")
    const task = await service.createTask({ companyTaxId: COMPANY, description: "x", dueDate: "2026-11-02" }, flavia)
    await service.archiveTask(task.id, flavia)
    await service.closeCompany(COMPANY, "No va", "santi")
    expect(await rejection(service.restoreTask(task.id, flavia))).toBe("company_closed")
    expect(await rejection(service.updateTask(task.id, { dueDate: "2026-11-09" }, flavia))).toBe("company_closed")
  })

  it("moves the CUIT when the origin source changes, and takes it out when it goes back to text", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME", originSource: "Poseidon" }, "santi")
    await service.updateCompany(COMPANY, { originSource: "Bolsa" }, "santi")
    expect(repository.cuits.get(COMPANY)?.sources).toEqual(["Bolsa"])
    await service.updateCompany(COMPANY, { crmOrigin: "Conocido" }, "santi")
    expect(repository.cuits.get(COMPANY)).toMatchObject({ sources: [], fields: { crmOrigin: "Conocido", originSource: null } })
  })

  it("queues the CUIT when a later edit points the origin to a known source, and not when it was searched", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME" }, "santi")
    expect((await service.updateCompany(COMPANY, { originSource: "Poseidon" }, "santi")).nosisPending).toBe(true)
    await service.addCompany({ taxId: OTHER, businessName: "OTRA" }, "santi")
    repository.cuits.get(OTHER)!.nosisSearched = true
    expect((await service.updateCompany(OTHER, { originSource: "Poseidon" }, "santi")).nosisPending).toBe(false)
  })

  it("lists the sources an origin can point to", async () => {
    expect((await service.listSources()).map((source) => source.name)).toEqual(["Poseidon", "Bolsa"])
  })

  it("closes a company with a reason, cancels its tasks and marks it Inservible when it is in a base", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME", originSource: "Poseidon" }, "santi")
    const task = await service.createTask({ companyTaxId: COMPANY, description: "Llamar", dueDate: "2026-11-02" }, flavia)
    const result = await service.closeCompany(COMPANY, " Cerró la empresa ", "flavia")
    expect(result).toMatchObject({
      cancelledTaskCount: 1,
      inservible: true,
      company: { closedAt: NOW.toISOString(), closedReason: "Cerró la empresa", closedBy: "flavia", openTaskCount: 0 },
    })
    expect(repository.tasks.get(task.id)).toMatchObject({ status: "cancelled", cancelReason: "Cerró la empresa" })
    expect(repository.cuits.get(COMPANY)).toMatchObject({ levelOfTrust: 1, trustReason: "Cerró la empresa" })
    expect(repository.changes.slice(-2).map((change) => change.operation)).toEqual(["close", "cancel"])
  })

  it("closes one outside every base without a trust level", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME" }, "santi")
    expect((await service.closeCompany(COMPANY, "No va", "santi")).inservible).toBe(false)
    expect(repository.cuits.get(COMPANY)?.levelOfTrust).toBeNull()
  })

  it("needs a reason, and does not close twice", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME" }, "santi")
    expect(await rejection(service.closeCompany(COMPANY, " ", "santi"))).toBe("close_reason_required")
    await service.closeCompany(COMPANY, "No va", "santi")
    expect(await rejection(service.closeCompany(COMPANY, "Otra vez", "santi"))).toBe("company_closed")
  })

  it("takes no new actions or tasks while closed, and reopens", async () => {
    await service.addCompany({ taxId: COMPANY, businessName: "ACME" }, "santi")
    await service.closeCompany(COMPANY, "No va", "santi")
    expect(
      await rejection(service.recordAction({ companyTaxId: COMPANY, date: "2026-10-29", description: "x", nextTask: NEXT }, flavia))
    ).toBe("company_closed")
    expect(await rejection(service.createTask({ companyTaxId: COMPANY, description: "x", dueDate: "2026-11-02" }, flavia))).toBe(
      "company_closed"
    )
    expect((await service.reopenCompany(COMPANY, "santi")).closedAt).toBeNull()
    expect(await rejection(service.reopenCompany(COMPANY, "santi"))).toBe("not_closed")
    expect(repository.changes.at(-1)?.operation).toBe("reopen")
  })
})
