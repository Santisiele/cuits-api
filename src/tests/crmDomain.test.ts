import { describe, it, expect } from "vitest"
import {
  canChangeAction,
  canChangeTask,
  changedFields,
  cleanText,
  isChangeEntityType,
  isOverdue,
  isRealDate,
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
  type Task,
} from "@domain/crm"

const NEVER_SEEN = { exists: false, inCrm: false, archived: false, nosisSearched: false, inKnownSource: false }

describe("shouldMarkNosisPending", () => {
  it("queues a CUIT only when it joins a known source", () => {
    expect(shouldMarkNosisPending(NEVER_SEEN, true)).toBe(true)
    expect(shouldMarkNosisPending({ ...NEVER_SEEN, exists: true }, true)).toBe(true)
  })

  it("never queues one that joins no known source, new or not", () => {
    expect(shouldMarkNosisPending(NEVER_SEEN, false)).toBe(false)
    expect(shouldMarkNosisPending({ ...NEVER_SEEN, exists: true }, false)).toBe(false)
  })

  it("leaves one that was already searched", () => {
    expect(shouldMarkNosisPending({ ...NEVER_SEEN, exists: true, nosisSearched: true }, true)).toBe(false)
  })

  it("leaves one that a known source already brought", () => {
    expect(shouldMarkNosisPending({ ...NEVER_SEEN, exists: true, inKnownSource: true }, true)).toBe(false)
  })
})

describe("removalOutcome", () => {
  const NOTHING = { createdByCrm: true, hasHistory: false, hasSource: false, relatedToBase: false, openTaskIds: [] }

  it("archives a company with CRM history, whatever else holds it", () => {
    expect(removalOutcome({ ...NOTHING, hasHistory: true })).toBe("archived")
  })

  it("deletes one left with nothing", () => {
    expect(removalOutcome(NOTHING)).toBe("deleted")
  })

  it("only unlinks one that a source still holds", () => {
    expect(removalOutcome({ ...NOTHING, hasSource: true })).toBe("unlinked")
  })

  it("only unlinks one related to the base", () => {
    expect(removalOutcome({ ...NOTHING, relatedToBase: true })).toBe("unlinked")
  })

  it("never deletes a CUIT the CRM did not create, so its Nosis relationships stay", () => {
    expect(removalOutcome({ ...NOTHING, createdByCrm: false })).toBe("unlinked")
  })
})

const TASK: Task = {
  id: "t1",
  companyTaxId: "30712345678",
  description: "Llamar",
  dueDate: "2026-10-30",
  status: "open",
  cancelReason: null,
  assignee: "Flavia",
  createdBy: "santi",
  contactIds: [],
  createdAt: "",
  closedAt: null,
  archivedAt: null,
}

const ACTION: Action = {
  id: "a1",
  companyTaxId: "30712345678",
  date: "2026-10-29",
  description: "Lo llamé",
  doneBy: "Flavia",
  recordedBy: "sol",
  contactIds: [],
  createdTaskId: null,
  completedTaskIds: [],
  createdAt: "",
  archivedAt: null,
}

describe("dates in Buenos Aires", () => {
  it("is still yesterday there before 03:00 UTC", () => {
    expect(todayInBuenosAires(new Date("2026-10-30T02:59:00.000Z"))).toBe("2026-10-29")
    expect(todayInBuenosAires(new Date("2026-10-30T03:00:00.000Z"))).toBe("2026-10-30")
  })

  it("calls a task overdue from its own day on", () => {
    expect(isOverdue("2026-10-29", "2026-10-30")).toBe(true)
    expect(isOverdue("2026-10-30", "2026-10-30")).toBe(true)
    expect(isOverdue("2026-10-31", "2026-10-30")).toBe(false)
  })

  it("accepts real yyyy-mm-dd days only", () => {
    expect(isValidCalendarDate("2026-10-29")).toBe(true)
    expect(isValidCalendarDate("2026-02-30")).toBe(false)
    expect(isValidCalendarDate("29/10/2026")).toBe(false)
    expect(isValidCalendarDate(20261029)).toBe(false)
  })
})

describe("taskStatusRejection", () => {
  it("never lets a task be marked done on its own: only an action that leaves the next one closes it", () => {
    expect(taskStatusRejection(TASK, "done", null)).toBe("invalid_status")
  })

  it("needs a reason to cancel", () => {
    expect(taskStatusRejection(TASK, "cancelled", null)).toBe("cancel_reason_required")
    expect(taskStatusRejection(TASK, "cancelled", "Ya no compra")).toBeNull()
  })

  it("refuses to close a task twice", () => {
    expect(taskStatusRejection({ ...TASK, status: "done" }, "cancelled", "x")).toBe("task_not_open")
  })

  it("refuses any other status", () => {
    expect(taskStatusRejection(TASK, "open", null)).toBe("invalid_status")
  })
})

describe("permissions", () => {
  const admin = { username: "santi", canAdminister: true }
  const flavia = { username: "flavia", canAdminister: false, responsibles: ["flavia", "Triunvirato"] }
  const sol = { username: "sol", canAdminister: false, responsibles: ["Sol"] }
  const pedro = { username: "pedro", canAdminister: false, responsibles: ["Pedro"] }

  it("lets admins change any action, members the ones they loaded or that stand for them", () => {
    expect(canChangeAction(admin, ACTION)).toBe(true)
    expect(canChangeAction(flavia, ACTION)).toBe(true)
    expect(canChangeAction(sol, ACTION)).toBe(true)
    expect(canChangeAction(pedro, ACTION)).toBe(false)
  })

  it("lets a member change a task they created or whose responsible stands for them, a group included", () => {
    expect(canChangeTask(admin, TASK)).toBe(true)
    expect(canChangeTask(flavia, TASK)).toBe(true)
    expect(canChangeTask(flavia, { ...TASK, assignee: "TRIUNVIRATO", createdBy: "sol" })).toBe(true)
    expect(canChangeTask({ username: "Santi", canAdminister: false }, TASK)).toBe(true)
    expect(canChangeTask(pedro, TASK)).toBe(false)
  })
})

describe("sortAgenda", () => {
  it("orders by due date, then company, then id", () => {
    const item = (id: string, dueDate: string, businessName: string) => ({ ...TASK, id, dueDate, businessName, overdue: false, lastAction: null })
    expect(
      sortAgenda([item("3", "2026-11-01", "A"), item("2", "2026-10-30", "B"), item("1", "2026-10-30", "B"), item("4", "2026-10-30", "A")]).map(
        (entry) => entry.id
      )
    ).toEqual(["4", "1", "2", "3"])
  })
})

describe("ids and history types", () => {
  it("reads id lists, treating a missing one as empty", () => {
    expect(uniqueIds(undefined)).toEqual([])
    expect(uniqueIds(null)).toEqual([])
    expect(uniqueIds(["3f2b8c1e-9a4d-4c7b-8e1f-0a2b3c4d5e6f", "3f2b8c1e-9a4d-4c7b-8e1f-0a2b3c4d5e6f"])).toHaveLength(1)
    expect(uniqueIds(["x"])).toBeNull()
    expect(uniqueIds("x")).toBeNull()
  })

  it("knows the history entry types", () => {
    expect(isChangeEntityType("Task")).toBe(true)
    expect(isChangeEntityType("CUIT")).toBe(false)
  })
})

describe("validation", () => {
  it("accepts an 11-digit CUIT only", () => {
    expect(isValidCrmCuit("30712345678")).toBe(true)
    expect(isValidCrmCuit("30-71234567-8")).toBe(false)
    expect(isValidCrmCuit(30712345678)).toBe(false)
  })

  it("accepts a UUID as an id", () => {
    expect(isValidCrmId("3f2b8c1e-9a4d-4c7b-8e1f-0a2b3c4d5e6f")).toBe(true)
    expect(isValidCrmId("nope")).toBe(false)
    expect(isValidCrmId(4)).toBe(false)
  })

  it("accepts real calendar days only", () => {
    expect(isRealDate(2024, 2, 29)).toBe(true)
    expect(isRealDate(2026, 2, 29)).toBe(false)
    expect(isRealDate(2026, 13, 1)).toBe(false)
  })

  it("reads birthdays as dd/mm/yyyy", () => {
    expect(isValidBirthday("06/05/1980")).toBe(true)
    expect(isValidBirthday("31/04/1980")).toBe(false)
    expect(isValidBirthday("1980-05-06")).toBe(false)
  })

  it("trims text and treats blank as missing", () => {
    expect(cleanText("  ACME  ")).toBe("ACME")
    expect(cleanText("   ")).toBeNull()
    expect(cleanText(4)).toBeNull()
  })

  it("measures length", () => {
    expect(isTooLong("abc", 2)).toBe(true)
    expect(isTooLong("ab", 2)).toBe(false)
    expect(isTooLong(null, 2)).toBe(false)
  })

  it("dedupes CUIT lists and refuses a bad one", () => {
    expect(uniqueTaxIds(["30712345678", "30712345678"])).toEqual(["30712345678"])
    expect(uniqueTaxIds(["30712345678", "x"])).toBeNull()
    expect(uniqueTaxIds("30712345678")).toBeNull()
    expect(uniqueTaxIds([])).toEqual([])
  })
})

describe("changedFields", () => {
  it("keeps only what changed, with missing values as null", () => {
    expect(changedFields({ a: 1, b: "x", c: ["1"] }, { a: 1, b: "y", c: ["1"], d: "new" })).toEqual({
      before: { b: "x", d: null },
      after: { b: "y", d: "new" },
    })
  })

  it("records a value cleared to null", () => {
    expect(changedFields({ a: "x" }, { a: null })).toEqual({ before: { a: "x" }, after: { a: null } })
  })
})
