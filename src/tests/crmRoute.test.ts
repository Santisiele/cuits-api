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

vi.mock("@auth/activityLogger.js", () => ({ logCrmOperation: vi.fn() }))

const { default: crmRoutes } = await import("@routes/crm")
const { logCrmOperation } = await import("@auth/activityLogger.js")

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  for (const schema of Object.values(schemas)) app.addSchema(schema)
  await app.register(async (instance) => {
    instance.addHook("preHandler", async (request) => {
      request.username = "flavia"
      request.role = "member"
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
    expect(response.json()).toEqual({ taxId: COMPANY, created: true, restored: false, nosisPending: true })
    expect(logCrmOperation).toHaveBeenCalledWith("flavia", "crm_add", "CrmCompany", COMPANY)
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
        nosisPending: true,
        addedAt: expect.any(String),
        addedBy: "flavia",
        lastActionDate: null,
        nextDueDate: null,
        openTaskCount: 0,
      },
    ])
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
    expect(preview.json()).toEqual({ outcome: "deleted", dryRun: true })
    expect(logCrmOperation).toHaveBeenCalledTimes(1)
    const real = await app.inject({ method: "DELETE", url: `/crm/companies/${COMPANY}` })
    expect(real.json()).toEqual({ outcome: "deleted", dryRun: false })
    expect(logCrmOperation).toHaveBeenLastCalledWith("flavia", "crm_remove_deleted", "CrmCompany", COMPANY)
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
