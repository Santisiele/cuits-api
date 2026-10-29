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
  it("creates a CUIT the graph does not have and queues it for Nosis", async () => {
    const result = await service.addCompany({ taxId: COMPANY, businessName: " ACME SA ", crmBrand: "Acme" }, "santi")
    expect(result).toEqual({ taxId: COMPANY, created: true, restored: false, nosisPending: true })
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
    expect(await service.companyDetail(COMPANY)).toMatchObject({ company: { taxId: COMPANY, crmBrand: "Acme" }, contacts: [] })
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
    expect(await service.removeCompany(COMPANY, true, "santi")).toEqual({ outcome: "deleted", dryRun: true })
    expect(repository.cuits.has(COMPANY)).toBe(true)
    expect(repository.changes).toHaveLength(1)
  })

  it("deletes one left with nothing", async () => {
    expect(await service.removeCompany(COMPANY, false, "santi")).toEqual({ outcome: "deleted", dryRun: false })
    expect(repository.deleted).toEqual([COMPANY])
    expect(repository.changes.at(-1)).toMatchObject({ operation: "crm_remove", after: { outcome: "deleted" } })
  })

  it("archives one with contacts", async () => {
    await service.createContact({ fullName: "Ana", companyTaxIds: [COMPANY] }, "santi")
    expect(await service.removeCompany(COMPANY, false, "santi")).toMatchObject({ outcome: "archived" })
    expect(repository.cuits.get(COMPANY)?.archivedAt).toBe(NOW.toISOString())
  })

  it("only unlinks one another source holds", async () => {
    repository.cuits.get(COMPANY)!.otherSources = ["Poseidon"]
    expect(await service.removeCompany(COMPANY, false, "santi")).toMatchObject({ outcome: "unlinked" })
    expect(repository.cuits.get(COMPANY)?.inSource).toBe(false)
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
    expect(repository.cuits.get(PERSON)).toMatchObject({ inSource: true, company: false, nosisPending: true })
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
