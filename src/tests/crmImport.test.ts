import { describe, it, expect } from "vitest"
import { isProductionUri, parseCompanyList } from "@domain/crmImport"

function row(Empresa: string, CUIT = "", extra: Record<string, string> = {}) {
  return { "Nombre y Apellido": "x", Empresa, CUIT, Marca: "", "Producto o Servicio": "", Origen: "", ...extra }
}

describe("parseCompanyList", () => {
  it("makes one company per name, with the CUIT cleaned and blank fields as null", () => {
    expect(parseCompanyList([row("Sifap SA", "30-50057827-7", { Marca: "Sifap", Origen: "Expopapelería" })]).companies).toEqual([
      { taxId: "30500578277", businessName: "Sifap SA", crmBrand: "Sifap", crmProduct: null, crmOrigin: "Expopapelería" },
    ])
  })

  it("merges the contact rows of one company and joins different values", () => {
    const parsed = parseCompanyList([
      row("Braku SA", "", { Marca: "Braku" }),
      row("Braku SA", "30712345678", { Marca: "Braku", Producto: "x" }),
      row("Braku SA", "30712345678", { Marca: "Otra" }),
    ])
    expect(parsed.companies).toEqual([
      { taxId: "30712345678", businessName: "Braku SA", crmBrand: "Braku / Otra", crmProduct: null, crmOrigin: null },
    ])
  })

  it("reports what cannot be loaded instead of loading it", () => {
    const parsed = parseCompanyList([
      row("Sin CUIT SA"),
      row("ACB SA", "307074982577"),
      row("Doble SA", "30712345678"),
      row("Doble SA", "30798765432"),
      row("Uno SA", "30711111111"),
      row("Otro nombre SA", "30711111111"),
      row(""),
    ])
    expect(parsed.companies.map((company) => company.businessName)).toEqual(["Uno SA"])
    expect(parsed.withoutCuit).toEqual(["Sin CUIT SA"])
    expect(parsed.invalidCuit).toEqual([{ businessName: "ACB SA", cuit: "307074982577" }])
    expect(parsed.conflicting).toEqual([
      { businessName: "Doble SA", cuits: ["30712345678", "30798765432"] },
      { businessName: "Otro nombre SA", cuits: ["30711111111"] },
    ])
  })

  it("tidies spaces in names", () => {
    expect(parseCompanyList([row("  Nam   importaciones SA ", "30712345678")]).companies[0]?.businessName).toBe("Nam importaciones SA")
  })
})

describe("isProductionUri", () => {
  it("recognises the Aura address", () => {
    expect(isProductionUri("neo4j+s://55116f69.databases.neo4j.io")).toBe(true)
    expect(isProductionUri("bolt://yamanote.proxy.rlwy.net:19642")).toBe(false)
  })
})
