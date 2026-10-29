import { describe, it, expect, beforeEach } from "vitest"
import { ResponsibleError, ResponsibleService } from "@application/ResponsibleService"
import { CrmCompanyService } from "@application/CrmCompanyService"
import { CrmWorkService } from "@application/CrmWorkService"
import {
  RESPONSIBLE_COLORS,
  cleanResponsibleName,
  isResponsibleColor,
  ownResponsible,
  responsiblesOf,
  sameResponsible,
  uniqueUsernames,
} from "@domain/responsibles"
import { InMemoryCrmRepository } from "./crmFakes"

const COMPANY = "30712345678"
const NOW = new Date("2026-10-29T15:00:00.000Z")

let repository: InMemoryCrmRepository
let responsibles: ResponsibleService
let companies: CrmCompanyService
let crm: CrmWorkService
let nextId: number

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
}

async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (err) {
    if (err instanceof ResponsibleError) return err.reason
    if (err instanceof Error && "reason" in err) return String((err as { reason: unknown }).reason)
    throw err
  }
  throw new Error("expected a rejection")
}

beforeEach(async () => {
  repository = new InMemoryCrmRepository()
  repository.users = ["luchi", "diego", "flavia", "sol"]
  repository.responsibles = [
    { name: "Luchi", color: "yellow", users: ["luchi"], disabled: false },
    { name: "Diego F", color: "violet", users: ["diego"], disabled: false },
    { name: "Flavia", color: "green", users: ["flavia"], disabled: false },
    { name: "Triunvirato", color: "orange", users: ["luchi", "diego", "flavia"], disabled: false },
    { name: "Sol", color: "blue-700", users: ["sol"], disabled: false },
    { name: "Raul", color: "sky-500", users: [], disabled: false },
  ]
  nextId = 0
  responsibles = new ResponsibleService(repository, () => NOW)
  companies = new CrmCompanyService(repository, () => NOW, () => id(++nextId))
  crm = new CrmWorkService(repository, () => NOW, () => id(++nextId))
  await companies.addCompany({ taxId: COMPANY, businessName: "ACME" }, "sol")
})

describe("responsible rules", () => {
  it("offers blues on top of the other colors", () => {
    expect(RESPONSIBLE_COLORS.filter((color) => /^(sky|blue|indigo|cyan)-/.test(color)).length).toBeGreaterThanOrEqual(10)
    expect(isResponsibleColor("blue-700")).toBe(true)
    expect(isResponsibleColor("#0000ff")).toBe(false)
  })

  it("tidies names and keeps them between 2 and 40 characters", () => {
    expect(cleanResponsibleName("  Diego   F ")).toBe("Diego F")
    expect(cleanResponsibleName("D")).toBeNull()
    expect(cleanResponsibleName("x".repeat(41))).toBeNull()
    expect(cleanResponsibleName(4)).toBeNull()
    expect(sameResponsible("diego  f", "Diego F")).toBe(true)
  })

  it("finds who stands for a user, groups included, and the user's own one", () => {
    const list = repository.responsibles
    expect(responsiblesOf(list, "LUCHI")).toEqual(["Luchi", "Triunvirato"])
    expect(ownResponsible(list, "luchi")).toBe("Luchi")
    expect(ownResponsible(list, "nadie")).toBeNull()
    expect(responsiblesOf([{ ...list[0]!, disabled: true }], "luchi")).toEqual([])
  })

  it("reads lists of usernames once each", () => {
    expect(uniqueUsernames(["luchi", "LUCHI", " diego "])).toEqual(["luchi", "diego"])
    expect(uniqueUsernames(undefined)).toEqual([])
    expect(uniqueUsernames("luchi")).toBeNull()
    expect(uniqueUsernames([1])).toBeNull()
  })
})

describe("ResponsibleService", () => {
  it("adds one with a color and linked users", async () => {
    const created = await responsibles.create({ name: "Natasha", color: "sky-700", users: ["SOL"] }, "admin")
    expect(created).toEqual({ name: "Natasha", color: "sky-700", users: ["sol"], disabled: false })
    expect((await responsibles.list()).map((responsible) => responsible.name)).toContain("Natasha")
  })

  it("validates name, color, users and duplicates", async () => {
    expect(await rejection(responsibles.create({ name: "N", color: "red" }, "admin"))).toBe("invalid_name")
    expect(await rejection(responsibles.create({ name: "Natasha", color: "#fff" }, "admin"))).toBe("invalid_color")
    expect(await rejection(responsibles.create({ name: "Natasha", color: "red", users: ["nadie"] }, "admin"))).toBe("user_not_found")
    expect(await rejection(responsibles.create({ name: "Natasha", color: "red", users: "sol" }, "admin"))).toBe("invalid_users")
    expect(await rejection(responsibles.create({ name: "raul", color: "red" }, "admin"))).toBe("name_taken")
  })

  it("renames, recolors, relinks and disables, carrying the new name onto the tasks", async () => {
    const task = await crm.createTask({ companyTaxId: COMPANY, description: "x", dueDate: "2026-11-02", assignee: "Raul" }, {
      username: "sol",
      canAdminister: false,
    })
    const updated = await responsibles.update("raul", { name: "Raúl", color: "blue-300", users: ["sol"], disabled: true }, "admin")
    expect(updated).toEqual({ name: "Raúl", color: "blue-300", users: ["sol"], disabled: true })
    expect(repository.tasks.get(task.id)?.assignee).toBe("Raúl")
    expect(repository.changes.at(-1)).toMatchObject({
      entityType: "Responsible",
      entityId: "Raúl",
      operation: "update",
      by: "admin",
      at: NOW.toISOString(),
      before: { name: "Raul", disabled: false },
      after: { name: "Raúl", disabled: true },
    })
    expect(await rejection(responsibles.update("Luchi", { name: "Sol" }, "admin"))).toBe("name_taken")
    expect(await rejection(responsibles.update("Nadie", {}, "admin"))).toBe("responsible_not_found")
    expect(await rejection(responsibles.update("Luchi", { disabled: "yes" }, "admin"))).toBe("invalid_disabled")
  })
})

describe("actions and tasks by responsible", () => {
  const sol = { username: "sol", canAdminister: false }
  const luchi = { username: "luchi", canAdminister: false }
  const NEXT = { description: "Seguir", dueDate: "2026-11-05" }

  it("lets Sol load an action done by someone else, keeping who loaded it", async () => {
    const { action, nextTask } = await crm.recordAction(
      { companyTaxId: COMPANY, doneBy: "raul", date: "2026-10-29", description: "x", nextTask: { ...NEXT, assignee: "raul" } },
      sol
    )
    expect(action).toMatchObject({ doneBy: "Raul", recordedBy: "sol" })
    expect(nextTask?.assignee).toBe("Raul")
  })

  it("fills in the user's own responsible when nothing is picked", async () => {
    const { action, nextTask } = await crm.recordAction({ companyTaxId: COMPANY, date: "2026-10-29", description: "x", nextTask: NEXT }, luchi)
    expect(action.doneBy).toBe("Luchi")
    expect(nextTask?.assignee).toBe("Luchi")
  })

  it("asks who did it when the user stands for nobody, and refuses unknown or disabled names", async () => {
    const admin = { username: "admin", canAdminister: true }
    expect(await rejection(crm.recordAction({ companyTaxId: COMPANY, date: "2026-10-29", description: "x", nextTask: NEXT }, admin))).toBe(
      "responsible_required"
    )
    expect(
      await rejection(crm.recordAction({ companyTaxId: COMPANY, doneBy: "Nadie", date: "2026-10-29", description: "x", nextTask: NEXT }, sol))
    ).toBe("responsible_not_found")
    repository.responsibles[5]!.disabled = true
    expect(
      await rejection(crm.createTask({ companyTaxId: COMPANY, description: "x", dueDate: "2026-11-02", assignee: "Raul" }, sol))
    ).toBe("responsible_not_found")
  })

  it("shows in my agenda my tasks and the ones of the groups I belong to", async () => {
    for (const assignee of ["Luchi", "Triunvirato", "Raul"]) {
      await crm.createTask({ companyTaxId: COMPANY, description: assignee, dueDate: "2026-11-02", assignee }, sol)
    }
    expect((await crm.agenda({}, luchi)).map((item) => item.assignee).sort()).toEqual(["Luchi", "Triunvirato"])
    expect((await crm.agenda({ assignee: "Raul" }, luchi)).map((item) => item.assignee)).toEqual(["Raul"])
    expect(await crm.agenda({}, { username: "admin", canAdminister: true })).toEqual([])
  })

  it("lets a group member change the group's task", async () => {
    const task = await crm.createTask({ companyTaxId: COMPANY, description: "x", dueDate: "2026-11-02", assignee: "Triunvirato" }, sol)
    expect((await crm.updateTask(task.id, { description: "y" }, luchi)).description).toBe("y")
  })
})
