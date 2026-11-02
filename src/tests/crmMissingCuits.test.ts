import { describe, it, expect } from "vitest"
import { FOUND_STATUS, NOT_FOUND_STATUS, foundCompanies, missingCuitRows, needsSearch } from "@domain/crmMissingCuits"

const LISTAS = [
  { Empresa: "ACME SA", CUIT: "30-71234567-8", "Nombre y Apellido": "Ana" },
  { Empresa: "Braku SA", CUIT: "", "Nombre y Apellido": "Andrés Braun" },
  { Empresa: "ACB SA", CUIT: "307074982577", "Nombre y Apellido": "Ariel" },
  { Empresa: "Copia SA", CUIT: "30712345678", "Nombre y Apellido": "" },
  { Empresa: "Sin nada", CUIT: "", "Nombre y Apellido": "" },
]

const SEGUIMIENTO = [
  { Empresa: "Braku SA", Nombre: "Andrés Braun", "Fecha Última Acción": 46300, "Qué se hizo?": "x", "Fecha Próxima Acción": 46302 },
  { Empresa: "Braku SA", Nombre: "Andrés Braun", "Fecha Última Acción": 46310, "Qué se hizo?": "y", "Fecha Próxima Acción": 46320 },
  { Empresa: "#N/A", Nombre: "Gustavo Carranza", "Fecha Última Acción": 46200, "Qué se hizo?": "z", "Fecha Próxima Acción": "" },
  { Empresa: "#N/A", Nombre: "Ana", "Fecha Última Acción": 46200, "Qué se hizo?": "w", "Fecha Próxima Acción": "" },
  { Empresa: "Nueva SRL", Nombre: "Pepe", "Fecha Última Acción": 46100, "Qué se hizo?": "v", "Fecha Próxima Acción": "" },
]

describe("missingCuitRows", () => {
  const rows = missingCuitRows(LISTAS, SEGUIMIENTO)
  const byName = new Map(rows.map((row) => [row.Empresa, row]))

  it("lists every company that cannot be loaded, with why", () => {
    expect(byName.get("Braku SA")?.Motivo).toBe("Sin CUIT en Listas")
    expect(byName.get("ACB SA")?.Motivo).toBe("CUIT mal escrito en Listas: 307074982577")
    expect(byName.get("Copia SA")?.Motivo).toBe("CUIT repetido con otra empresa: 30712345678")
    expect(byName.get("Nueva SRL")?.Motivo).toBe("Está en Seguimiento pero no en Listas")
    expect(byName.get("#N/A")?.Motivo).toBe("Fila de Seguimiento sin empresa (buscar por contacto)")
    expect(byName.has("ACME SA")).toBe(false)
  })

  it("brings the contact, how much history it has and its last and next dates, busiest first", () => {
    expect(rows[0]).toMatchObject({
      Empresa: "Braku SA",
      Contacto: "Andrés Braun",
      "Acciones en Seguimiento": 2,
      "Última acción": "15/10/2026",
      "Próxima acción": "25/10/2026",
      CUIT: "",
    })
  })

  it("files a row without company under the company its contact belongs to, like the import does", () => {
    expect(byName.get("#N/A")?.["Acciones en Seguimiento"]).toBe(1)
    expect(byName.get("#N/A")?.Contacto).toBe("Gustavo Carranza")
  })
})

describe("needsSearch", () => {
  it("searches rows never searched and skips the ones with a CUIT or no company", () => {
    expect(needsSearch({ Empresa: "Braku SA", CUIT: "", Estado: "" }, false)).toBe(true)
    expect(needsSearch({ Empresa: "Braku SA", CUIT: "30-71234567-8", Estado: "" }, false)).toBe(false)
    expect(needsSearch({ Empresa: "#N/A", CUIT: "", Estado: "" }, false)).toBe(false)
  })

  it("retries the ones not found only when asked", () => {
    expect(needsSearch({ Empresa: "Braku SA", CUIT: "", Estado: NOT_FOUND_STATUS }, false)).toBe(false)
    expect(needsSearch({ Empresa: "Braku SA", CUIT: "", Estado: NOT_FOUND_STATUS }, true)).toBe(true)
    expect(needsSearch({ Empresa: "Braku SA", CUIT: "", Estado: FOUND_STATUS }, true)).toBe(false)
  })
})

describe("foundCompanies", () => {
  const FOUND = [
    { Empresa: "Braku SA", Contacto: "Andrés Braun", CUIT: "30-71081116-0", "Nombre en Nosis": "Braku SA" },
    { Empresa: "Shackie", Contacto: "Nuria", CUIT: "30711355657", "Nombre en Nosis": "Shackie SRL" },
    { Empresa: "Shackie bis", Contacto: "", CUIT: "30711355657", "Nombre en Nosis": "Shackie SRL" },
    { Empresa: "#N/A", Contacto: "Gustavo Carranza", CUIT: "20111111119", "Nombre en Nosis": "" },
    { Empresa: "Grupo Piero", Contacto: "", CUIT: "", "Nombre en Nosis": "" },
    { Empresa: "ACB SA", Contacto: "", CUIT: "307074982577", "Nombre en Nosis": "" },
  ]
  const LISTAS_WITH_FIELDS = [
    { Empresa: "Braku SA", CUIT: "", "Nombre y Apellido": "Andrés Braun", Marca: "Plus", "Producto o Servicio": "Motos", Origen: "Bolsa" },
    { Empresa: "Braku SA", CUIT: "", "Nombre y Apellido": "Otro", Marca: "Plus", "Producto o Servicio": "Insumos", Origen: "" },
  ]
  const result = foundCompanies(FOUND, LISTAS_WITH_FIELDS)

  it("loads each CUIT once with the name Nosis gave and what Listas says about it", () => {
    expect(result.companies.map((company) => company.taxId)).toEqual(["30710811160", "30711355657", "20111111119"])
    expect(result.companies[0]).toEqual({
      taxId: "30710811160",
      businessName: "Braku SA",
      crmBrand: "Plus",
      crmProduct: "Motos / Insumos",
      crmOrigin: "Bolsa",
    })
  })

  it("sends the history of a second name with the same CUIT to the first one", () => {
    expect(result.taxIdByCompany.get("Shackie bis")).toBe("30711355657")
    expect(result.skipped).toContainEqual({ name: "Shackie bis", reason: "mismo CUIT que Shackie, su historial va a esa empresa" })
  })

  it("names a row without company after its contact, so its history finds it", () => {
    expect(result.taxIdByCompany.get("Gustavo Carranza")).toBe("20111111119")
    expect(result.companyByContact.get("gustavo carranza")).toBe("Gustavo Carranza")
  })

  it("leaves out rows with no CUIT or a malformed one", () => {
    expect(result.skipped).toContainEqual({ name: "Grupo Piero", reason: "sin CUIT" })
    expect(result.skipped).toContainEqual({ name: "ACB SA", reason: "CUIT mal escrito: 307074982577" })
  })
})
