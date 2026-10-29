import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { schemas } from "@schemas.js"
import { InMemoryCrmRepository } from "./crmFakes"

const state = { repository: new InMemoryCrmRepository() }

vi.mock("@infrastructure/neo4j/Neo4jCrmRepository.js", () => ({
  Neo4jCrmRepository: class {
    constructor() {
      return new Proxy(
        {},
        {
          get: (_target, key: string) => {
            const method = (state.repository as unknown as Record<string, unknown>)[key]
            return typeof method === "function" ? method.bind(state.repository) : method
          },
        }
      )
    }
  },
}))

vi.mock("@auth/activityLogger.js", () => ({ logCrmOperation: vi.fn(), logForbidden: vi.fn() }))

const { default: crmRoutes } = await import("@routes/crm")
const { logCrmOperation } = await import("@auth/activityLogger.js")

async function buildApp(role: "creator" | "admin" | "member" = "member"): Promise<FastifyInstance> {
  const app = Fastify()
  for (const schema of Object.values(schemas)) app.addSchema(schema)
  await app.register(async (instance) => {
    instance.addHook("preHandler", async (request) => {
      request.username = "flavia"
      request.role = role
    })
    await instance.register(crmRoutes)
  })
  await app.ready()
  return app
}

const COMPANY = "30712345678"

let app: FastifyInstance

beforeEach(async () => {
  state.repository = new InMemoryCrmRepository()
  vi.mocked(logCrmOperation).mockClear()
  app = await buildApp()
})

async function addCompany(): Promise<void> {
  await app.inject({
    method: "POST",
    url: "/crm/companies",
    payload: { taxId: COMPANY, businessName: "ACME SA", crmBrand: "Acme", crmProduct: "Seguros", crmOrigin: "Referido" },
  })
}

describe("crm company routes", () => {
  it("lets a member add a company and answers 201 with every field", async () => {
    const response = await app.inject({ method: "POST", url: "/crm/companies", payload: { taxId: COMPANY, businessName: "ACME SA" } })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ taxId: COMPANY, created: true, restored: false, nosisPending: false })
    expect(logCrmOperation).toHaveBeenCalledWith("flavia", "crm_add", "CrmCompany", COMPANY, { businessName: "ACME SA", originSource: null })
  })

  it("lists companies without dropping fields", async () => {
    await addCompany()
    const response = await app.inject({ method: "GET", url: "/crm/companies" })
    expect(response.json().companies).toEqual([
      {
        taxId: COMPANY,
        businessName: "ACME SA",
        crmBrand: "Acme",
        crmProduct: "Seguros",
        crmOrigin: "Referido",
        originSource: null,
        nosisPending: false,
        addedAt: expect.any(String),
        addedBy: "flavia",
        lastActionDate: null,
        nextDueDate: null,
        openTaskCount: 0,
        closedAt: null,
        closedReason: null,
        closedBy: null,
      },
    ])
  })

  it("closes and reopens a company, answering every field", async () => {
    await addCompany()
    const missing = await app.inject({ method: "POST", url: `/crm/companies/${COMPANY}/close`, payload: {} })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toBe("close_reason_required")

    const closed = await app.inject({ method: "POST", url: `/crm/companies/${COMPANY}/close`, payload: { reason: "No va más" } })
    expect(closed.json()).toMatchObject({
      cancelledTaskCount: 0,
      inservible: false,
      company: { taxId: COMPANY, closedReason: "No va más", closedBy: "flavia", closedAt: expect.any(String) },
    })
    expect(logCrmOperation).toHaveBeenLastCalledWith("flavia", "close", "CrmCompany", COMPANY, {
      businessName: "ACME SA",
      reason: "No va más",
      inservible: false,
    })

    const reopened = await app.inject({ method: "POST", url: `/crm/companies/${COMPANY}/reopen` })
    expect(reopened.json()).toMatchObject({ closedAt: null, closedReason: null })
    expect((await app.inject({ method: "POST", url: `/crm/companies/${COMPANY}/reopen` })).statusCode).toBe(409)
  })

  it("lists the sources for the origin and refuses an unknown one with 404", async () => {
    expect((await app.inject({ method: "GET", url: "/crm/sources" })).json()).toEqual({
      sources: [
        { name: "Poseidon", category: "known" },
        { name: "Bolsa", category: "toKnow" },
      ],
    })
    const response = await app.inject({
      method: "POST",
      url: "/crm/companies",
      payload: { taxId: COMPANY, businessName: "ACME", originSource: "Nada" },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe("source_not_found")
  })

  it("answers the codes the front translates", async () => {
    expect((await app.inject({ method: "POST", url: "/crm/companies", payload: { taxId: COMPANY } })).json()).toMatchObject({
      error: "business_name_required",
    })
    await addCompany()
    const taken = await app.inject({ method: "POST", url: "/crm/companies", payload: { taxId: COMPANY } })
    expect(taken.statusCode).toBe(409)
    expect(taken.json().error).toBe("already_in_crm")
    const missing = await app.inject({ method: "GET", url: "/crm/companies/30798765432" })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe("company_not_in_crm")
    const malformed = await app.inject({ method: "GET", url: "/crm/companies/abc" })
    expect(malformed.statusCode).toBe(400)
  })

  it("changes the CRM data", async () => {
    await addCompany()
    const response = await app.inject({ method: "PATCH", url: `/crm/companies/${COMPANY}`, payload: { crmBrand: "Nueva" } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ taxId: COMPANY, crmBrand: "Nueva", crmProduct: null })
  })

  it("previews the removal and only logs the real one", async () => {
    await addCompany()
    const preview = await app.inject({ method: "DELETE", url: `/crm/companies/${COMPANY}?dryRun=true` })
    expect(preview.json()).toEqual({ outcome: "deleted", cancelledTaskCount: 0, dryRun: true })
    expect(logCrmOperation).toHaveBeenCalledTimes(1)
    const real = await app.inject({ method: "DELETE", url: `/crm/companies/${COMPANY}` })
    expect(real.json()).toEqual({ outcome: "deleted", cancelledTaskCount: 0, dryRun: false })
    expect(logCrmOperation).toHaveBeenLastCalledWith("flavia", "crm_remove", "CrmCompany", COMPANY, { outcome: "deleted" })
  })
})

describe("crm contact routes", () => {
  it("creates, shows, changes, archives and restores a contact with every field", async () => {
    await addCompany()
    const created = await app.inject({
      method: "POST",
      url: "/crm/contacts",
      payload: { fullName: "Ana Pérez", companyTaxIds: [COMPANY], phone: "11 5555", email: "ana@acme.com", birthday: "06/05/1980" },
    })
    expect(created.statusCode).toBe(201)
    const contact = created.json()
    expect(contact).toEqual({
      id: expect.any(String),
      fullName: "Ana Pérez",
      phone: "11 5555",
      email: "ana@acme.com",
      birthday: "06/05/1980",
      cuil: null,
      companyTaxIds: [COMPANY],
      createdAt: expect.any(String),
      archivedAt: null,
    })

    const detail = await app.inject({ method: "GET", url: `/crm/companies/${COMPANY}` })
    expect(detail.json().contacts).toEqual([contact])

    const changed = await app.inject({ method: "PATCH", url: `/crm/contacts/${contact.id}`, payload: { phone: null } })
    expect(changed.json()).toMatchObject({ phone: null, email: "ana@acme.com" })

    const archived = await app.inject({ method: "DELETE", url: `/crm/contacts/${contact.id}` })
    expect(archived.json().archivedAt).toEqual(expect.any(String))
    const again = await app.inject({ method: "DELETE", url: `/crm/contacts/${contact.id}` })
    expect(again.statusCode).toBe(409)

    const restored = await app.inject({ method: "POST", url: `/crm/contacts/${contact.id}/restore` })
    expect(restored.json().archivedAt).toBeNull()
  })

  it("refuses a bad birthday with 400", async () => {
    await addCompany()
    const response = await app.inject({
      method: "POST",
      url: "/crm/contacts",
      payload: { fullName: "Ana", companyTaxIds: [COMPANY], birthday: "1980-05-06" },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe("invalid_date")
  })

  it("answers 404 for a contact that does not exist", async () => {
    const response = await app.inject({ method: "PATCH", url: "/crm/contacts/nope", payload: {} })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe("contact_not_found")
  })
})

describe("crm action, task and agenda routes", () => {
  const TASK_FIELDS = {
    id: expect.any(String),
    companyTaxId: COMPANY,
    description: "Mandar propuesta",
    dueDate: "2026-11-02",
    status: "open",
    cancelReason: null,
    assignee: "Flavia",
    createdBy: "flavia",
    contactIds: [],
    createdAt: expect.any(String),
    closedAt: null,
    archivedAt: null,
  }

  async function recordAction() {
    await addCompany()
    state.repository.users = ["flavia", "santi"]
    return app.inject({
      method: "POST",
      url: "/crm/actions",
      payload: {
        companyTaxId: COMPANY,
        date: "2026-10-29",
        description: "Lo llamé",
        nextTask: { description: "Mandar propuesta", dueDate: "2026-11-02" },
      },
    })
  }

  it("records an action and answers every field of it and its next task", async () => {
    const response = await recordAction()
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      action: {
        id: expect.any(String),
        companyTaxId: COMPANY,
        date: "2026-10-29",
        description: "Lo llamé",
        doneBy: "Flavia",
        recordedBy: "flavia",
        contactIds: [],
        createdTaskId: expect.any(String),
        completedTaskIds: [],
        createdAt: expect.any(String),
        archivedAt: null,
      },
      closedTasks: [],
      nextTask: TASK_FIELDS,
    })
  })

  it("refuses an action that leaves no next task", async () => {
    await addCompany()
    const response = await app.inject({
      method: "POST",
      url: "/crm/actions",
      payload: { companyTaxId: COMPANY, date: "2026-10-29", description: "x" },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe("next_task_required")
  })

  it("serves the agenda with the company name and overdue flag", async () => {
    await recordAction()
    const response = await app.inject({ method: "GET", url: "/crm/agenda?assignee=all" })
    expect(response.json().tasks).toEqual([{ ...TASK_FIELDS, businessName: "ACME SA", overdue: expect.any(Boolean) }])
  })

  it("shows actions and tasks on the company", async () => {
    await recordAction()
    const detail = (await app.inject({ method: "GET", url: `/crm/companies/${COMPANY}` })).json()
    expect(detail.actions).toHaveLength(1)
    expect(detail.tasks).toEqual([TASK_FIELDS])
  })

  it("cancels a task and serves its history with the changed values", async () => {
    const taskId = (await recordAction()).json().nextTask.id
    const missingReason = await app.inject({ method: "PATCH", url: `/crm/tasks/${taskId}`, payload: { status: "cancelled" } })
    expect(missingReason.statusCode).toBe(400)
    expect(missingReason.json().error).toBe("cancel_reason_required")

    const cancelled = await app.inject({
      method: "PATCH",
      url: `/crm/tasks/${taskId}`,
      payload: { status: "cancelled", cancelReason: "Ya no compra" },
    })
    expect(cancelled.json()).toMatchObject({ status: "cancelled", cancelReason: "Ya no compra" })
    expect(logCrmOperation).toHaveBeenLastCalledWith("flavia", "cancelled", "Task", taskId, {
      companyTaxId: COMPANY,
      assignee: "Flavia",
      dueDate: "2026-11-02",
      description: "Mandar propuesta",
      cancelReason: "Ya no compra",
    })

    const history = await app.inject({ method: "GET", url: `/crm/changes?entityType=Task&entityId=${taskId}` })
    expect(history.json().changes[0]).toEqual({
      id: expect.any(String),
      at: expect.any(String),
      by: "flavia",
      entityType: "Task",
      entityId: taskId,
      operation: "cancel",
      before: { status: "open", cancelReason: null },
      after: { status: "cancelled", cancelReason: "Ya no compra" },
    })
  })

  it("answers 403 when a member touches someone else's task", async () => {
    await addCompany()
    state.repository.users = ["flavia", "santi"]
    await app.inject({
      method: "POST",
      url: "/crm/tasks",
      payload: { companyTaxId: COMPANY, description: "x", dueDate: "2026-11-02", assignee: "santi" },
    })
    const stored = [...state.repository.tasks.values()][0]!
    state.repository.tasks.set(stored.id, { ...stored, createdBy: "santi" })
    const response = await app.inject({ method: "DELETE", url: `/crm/tasks/${stored.id}` })
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe("forbidden")
  })

  it("lists the users a task can be assigned to", async () => {
    state.repository.users = ["flavia", "santi"]
    expect((await app.inject({ method: "GET", url: "/crm/users" })).json()).toEqual({ users: [{ username: "flavia", color: null }, { username: "santi", color: null }] })
  })
})

describe("the Nosis pending list", () => {
  it("is only for the creator", async () => {
    for (const role of ["member", "admin"] as const) {
      const other = await buildApp(role)
      expect((await other.inject({ method: "GET", url: "/crm/nosis-pending" })).statusCode).toBe(403)
    }
  })

  it("lists only the pending CUITs that are in a known source, with who added them and the command", async () => {
    await addCompany()
    await app.inject({
      method: "POST",
      url: "/crm/companies",
      payload: { taxId: "30798765432", businessName: "OTRA SA", originSource: "Poseidon" },
    })
    const creator = await buildApp("creator")
    const response = await creator.inject({ method: "GET", url: "/crm/nosis-pending" })
    expect(response.json()).toEqual({
      command: "pnpm crm:nosis",
      items: [{ taxId: "30798765432", businessName: "OTRA SA", sources: ["Poseidon"], addedBy: "flavia", addedAt: expect.any(String) }],
    })
  })
})

describe("responsible routes", () => {
  it("lists them to anyone with every field", async () => {
    const response = await app.inject({ method: "GET", url: "/crm/responsibles" })
    expect(response.json().responsibles[0]).toEqual({ name: "santi", color: "orange", users: ["santi"], disabled: false })
  })

  it("lets only admins add or change them", async () => {
    const member = await app.inject({ method: "POST", url: "/crm/responsibles", payload: { name: "Raul", color: "sky-500" } })
    expect(member.statusCode).toBe(403)
    const admin = await buildApp("admin")
    const created = await admin.inject({ method: "POST", url: "/crm/responsibles", payload: { name: "Raul", color: "sky-500" } })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toEqual({ name: "Raul", color: "sky-500", users: [], disabled: false })
    const taken = await admin.inject({ method: "POST", url: "/crm/responsibles", payload: { name: "raul", color: "red" } })
    expect(taken.statusCode).toBe(409)
    expect(taken.json().error).toBe("name_taken")
    const changed = await admin.inject({ method: "PATCH", url: "/crm/responsibles/Raul", payload: { color: "blue-900" } })
    expect(changed.json().color).toBe("blue-900")
  })
})
