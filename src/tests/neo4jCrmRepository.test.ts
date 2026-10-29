import { describe, it, expect, vi, beforeEach } from "vitest"
import neo4j from "neo4j-driver"
import type { Change, Task } from "@domain/crm"

type Row = Record<string, unknown>

const state = {
  calls: [] as { query: string; params: Record<string, unknown> }[],
  respond: (_query: string): Row[] => [],
}

function run(query: string, params: Record<string, unknown> = {}) {
  state.calls.push({ query, params })
  return Promise.resolve({ records: state.respond(query).map((row) => ({ get: (key: string) => row[key] })) })
}

vi.mock("@infrastructure/neo4j/Neo4jDriver.js", () => ({
  Neo4jDriver: {
    instance: {
      session: () => ({
        run,
        executeWrite: async (work: (tx: { run: typeof run }) => Promise<unknown>) => work({ run }),
        close: async () => {},
      }),
    },
  },
}))

const { Neo4jCrmRepository } = await import("@infrastructure/neo4j/Neo4jCrmRepository")
const { Queries } = await import("@infrastructure/neo4j/queries")
const { CompanyClosedError, TaskChangedError, TaskNoLongerOpenError } = await import("@domain/crm")

const repository = new Neo4jCrmRepository()
const AT = "2026-10-29T15:00:00.000Z"
const COMPANY = "30712345678"

const TASK: Task = {
  id: "t1",
  companyTaxId: COMPANY,
  description: "Llamar",
  dueDate: "2026-11-02",
  status: "open",
  cancelReason: null,
  assignee: "Flavia",
  createdBy: "santi",
  contactIds: [],
  createdAt: AT,
  closedAt: null,
  archivedAt: null,
}

function change(entityType: Change["entityType"], entityId: string): Change {
  return { id: `ch-${entityId}`, at: AT, by: "santi", entityType, entityId, operation: "update", before: {}, after: {} }
}

function queriesRun(): string[] {
  return state.calls.map((call) => call.query)
}

function wrote(query: string): boolean {
  return queriesRun().includes(query)
}

beforeEach(() => {
  state.calls = []
  state.respond = () => []
})

describe("task writes", () => {
  it("writes an edit only over the task as it was read, and leaves no history when it changed meanwhile", async () => {
    state.respond = (query) => (query === Queries.CRM_SET_TASK ? [{ updated: neo4j.int(0) }] : [])
    await expect(repository.updateTask({ ...TASK, description: "Otra" }, change("Task", "t1"), TASK)).rejects.toBeInstanceOf(TaskChangedError)
    expect(state.calls[0]?.params).toMatchObject({ expectedStatus: "open", expectedArchivedAt: null, description: "Otra" })
    expect(wrote(Queries.CRM_WRITE_CHANGE)).toBe(false)
  })

  it("records the history when the edit lands", async () => {
    state.respond = (query) => (query === Queries.CRM_SET_TASK ? [{ updated: neo4j.int(1) }] : [])
    await repository.updateTask(TASK, change("Task", "t1"), TASK)
    expect(wrote(Queries.CRM_WRITE_CHANGE)).toBe(true)
  })

  it("refuses a new task on a company closed meanwhile, before writing anything", async () => {
    state.respond = (query) => (query === Queries.CRM_LOCK_OPEN_COMPANY ? [{ open: false }] : [])
    await expect(repository.createTask(TASK, change("Task", "t1"))).rejects.toBeInstanceOf(CompanyClosedError)
    expect(queriesRun()).toEqual([Queries.CRM_LOCK_OPEN_COMPANY])
  })

  it("refuses an action that would complete a task someone else already completed", async () => {
    state.respond = (query) =>
      query === Queries.CRM_LOCK_OPEN_COMPANY ? [{ open: true }] : query === Queries.CRM_COMPLETE_TASK ? [{ completed: neo4j.int(0) }] : []
    const action = {
      id: "a1",
      companyTaxId: COMPANY,
      date: "2026-10-29",
      description: "x",
      doneBy: "Flavia",
      recordedBy: "santi",
      contactIds: [],
      createdTaskId: null,
      completedTaskIds: ["t1"],
      createdAt: AT,
      archivedAt: null,
    }
    await expect(repository.recordAction(action, [{ ...TASK, status: "done", closedAt: AT }], null, [])).rejects.toBeInstanceOf(
      TaskNoLongerOpenError
    )
  })
})

describe("companies", () => {
  it("closes first, then cancels the open tasks and leaves one history entry per task it cancelled", async () => {
    state.respond = (query) =>
      query === Queries.CRM_CLOSE_COMPANY ? [{ inservible: true }] : query === Queries.CRM_CANCEL_OPEN_TASKS ? [{ id: "t1" }, { id: "t2" }] : []
    const result = await repository.closeCompany(COMPANY, "No va", AT, "santi", change("CrmCompany", COMPANY), (id) => change("Task", id))
    expect(result).toEqual({ inservible: true, cancelledTaskIds: ["t1", "t2"] })
    expect(queriesRun().indexOf(Queries.CRM_CLOSE_COMPANY)).toBeLessThan(queriesRun().indexOf(Queries.CRM_CANCEL_OPEN_TASKS))
    const changeIds = state.calls.filter((call) => call.query === Queries.CRM_WRITE_CHANGE).map((call) => call.params["entityId"])
    expect(changeIds).toEqual([COMPANY, "t1", "t2"])
  })

  it("reads what decides a removal", async () => {
    state.respond = () => [{ createdByCrm: true, hasHistory: false, hasSource: false, relatedToBase: true, openTaskIds: ["t1"] }]
    expect(await repository.findRemovalFacts(COMPANY)).toEqual({
      createdByCrm: true,
      hasHistory: false,
      hasSource: false,
      relatedToBase: true,
      openTaskIds: ["t1"],
    })
  })

  it("takes the CUIT out of the sources the CRM put it in before unlinking it, and deletes nothing it only unlinks", async () => {
    await repository.removeCompany(COMPANY, "unlinked", AT, [])
    expect(queriesRun()).toEqual([Queries.CRM_DETACH_CRM_SOURCES, Queries.CRM_UNLINK_COMPANY])
  })

  it("adds the person and the contact in one transaction", async () => {
    const contact = {
      id: "c1",
      fullName: "Ana",
      phone: null,
      email: null,
      birthday: null,
      cuil: "20301234567",
      companyTaxIds: [COMPANY],
      createdAt: AT,
      archivedAt: null,
    }
    const add = {
      taxId: "20301234567",
      businessName: "Ana",
      crmBrand: null,
      crmProduct: null,
      crmOrigin: null,
      originSource: null,
      asCompany: false,
      markNosisPending: false,
      at: AT,
      by: "santi",
    }
    await repository.createContact(contact, change("Contact", "c1"), { add, change: change("CrmCompany", "20301234567") })
    expect(queriesRun().filter((query) => query !== Queries.CRM_WRITE_CHANGE && !query.includes("[:CHANGED]"))).toEqual([
      Queries.CRM_ADD_CUIT,
      Queries.CRM_CREATE_CONTACT,
      Queries.CRM_LINK_CONTACT,
    ])
  })
})

describe("history", () => {
  it("links a responsible's history to the responsible by its name key", async () => {
    state.respond = (query) => (query === Queries.UPDATE_RESPONSIBLE ? [{ name: "Raúl" }] : [])
    await repository.updateResponsible("raul", { name: "Raúl", color: "red", users: [], disabled: false }, AT, change("Responsible", "Raúl"))
    const link = state.calls.find((call) => call.query.includes("[:CHANGED]"))!
    expect(link.query).toContain("Responsible {nameKey: $entityId}")
    expect(link.params["entityId"]).toBe("raúl")
  })

  it("links a user's history by its username key and anything else by its id", async () => {
    state.respond = () => [{ updated: neo4j.int(1) }]
    await repository.updateTask(TASK, change("Task", "t1"), TASK)
    const link = state.calls.find((call) => call.query.includes("[:CHANGED]"))!
    expect(link.query).toContain("Task {id: $entityId}")
    expect(link.params["entityId"]).toBe("t1")
  })
})
