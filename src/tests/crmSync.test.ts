import { describe, it, expect } from "vitest"
import { syncChanges, taskToComplete } from "@domain/crmSync"
import type { Action, Task } from "@domain/crm"
import type { HistoryStep } from "@domain/crmHistoryImport"

const step = (date: string, description: string, nextTask: HistoryStep["nextTask"] = null): HistoryStep => ({
  taxId: "30712345678",
  businessName: "ACME",
  date,
  description,
  doneBy: "Raul",
  nextTask,
})

const action = (id: string, date: string, description: string, createdTaskId: string | null, contactIds: string[] = []): Action => ({
  id,
  companyTaxId: "30712345678",
  date,
  description,
  doneBy: "Raul",
  recordedBy: "admin",
  contactIds,
  createdTaskId,
  completedTaskIds: [],
  createdAt: `${date}T10:00:00.000Z`,
  archivedAt: null,
})

const task = (id: string, dueDate: string, assignee = "Raul", description = "seguirlo"): Task => ({
  id,
  companyTaxId: "30712345678",
  description,
  dueDate,
  status: "open",
  cancelReason: null,
  assignee,
  createdBy: "admin",
  contactIds: [],
  createdAt: `${dueDate}T00:00:00.000Z`,
  closedAt: null,
  archivedAt: null,
  postponements: [],
})

describe("syncChanges", () => {
  const loaded = [action("a1", "2026-10-26", "hable con nahuel, ignacio no estaba x unos dias", "t1", ["k1"])]
  const tasks = [task("t1", "2026-11-05")]

  it("finds the rows that are not loaded yet and skips impossible dates", () => {
    const changes = syncChanges([step("2026-11-02", "Con Fabian: opero"), step("+020266-04-15", "x")], loaded, tasks)
    expect(changes.map((change) => change.kind)).toEqual(["new"])
  })

  it("treats a row whose text grew as the same action, and a later next date as a postponement", () => {
    const changes = syncChanges(
      [step("2026-10-26", "Con Fabian: hable con nahuel, ignacio no estaba x unos dias. volvi a llamar", { description: "seguirlo", dueDate: "2026-11-18", assignee: "Raul" })],
      loaded,
      tasks
    )
    expect(changes.map((change) => change.kind)).toEqual(["text", "postpone"])
  })

  it("edits the next task when its responsable or text changed, and moves it back when the date is earlier", () => {
    const changes = syncChanges([step("2026-10-26", "Con Fabian: hable con nahuel, ignacio no estaba x unos dias", { description: "llamarlo", dueDate: "2026-11-01", assignee: "Natasha" })], loaded, tasks)
    expect(changes).toEqual([expect.objectContaining({ kind: "edit", fields: { dueDate: "2026-11-01", assignee: "Natasha", description: "llamarlo" } })])
  })

  it("adds the next task a loaded last action did not have", () => {
    const changes = syncChanges([step("2026-10-30", "cero bola", { description: "(sin detalle)", dueDate: "2026-11-18", assignee: "Tomi J" })], [action("a2", "2026-10-30", "cero bola", null)], [])
    expect(changes.map((change) => change.kind)).toEqual(["next"])
  })

  it("adds that next task only once", () => {
    const changes = syncChanges([step("2026-10-30", "cero bola", { description: "(sin detalle)", dueDate: "2026-11-18", assignee: "Tomi J" })], [action("a2", "2026-10-30", "cero bola", null)], [task("t9", "2026-11-18", "Tomi J")])
    expect(changes).toEqual([])
  })
})

describe("taskToComplete", () => {
  it("completes the only open task, or the one opened with the same contact", () => {
    const actions = [action("a1", "2026-10-15", "x", "t1", ["silvina"]), action("a2", "2026-09-16", "y", "t2", ["quique"])]
    const open = [task("t1", "2026-10-28"), task("t2", "2026-12-10", "Diego F")]
    const contacts = new Map([["silvina stok", "silvina"], ["quique chirom", "quique"]])
    expect(taskToComplete([open[0]!], actions, contacts, step("2026-11-02", "opero"))?.id).toBe("t1")
    expect(taskToComplete(open, actions, contacts, step("2026-11-02", "Con Quique Chirom: opero"))?.id).toBe("t2")
    expect(taskToComplete(open, actions, contacts, step("2026-11-02", "Con Silvina Stok: opero"))?.id).toBe("t1")
    expect(taskToComplete([], actions, contacts, step("2026-11-02", "opero"))).toBeNull()
  })
})
