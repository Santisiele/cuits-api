import { describe, it, expect } from "vitest"
import { birthdayFrom, contactInDescription, foundContactRows, parseListasContacts, stepsNotLoaded } from "@domain/crmContactImport"

const COMPANIES = new Map([
  ["Braku SA", "30710811160"],
  ["Otra SA", "30712345678"],
])

describe("parseListasContacts", () => {
  const parsed = parseListasContacts(
    [
      { "Nombre y Apellido": "Andrés Braun", Empresa: "Braku SA", Contacto: "11-5428-3796", Cumple: 27656, "CUIL Contacto": "20-24560567-7" },
      { "Nombre y Apellido": "andres  braun", Empresa: "Otra SA", Contacto: "andres@braku.com", Cumple: "", "CUIL Contacto": "" },
      { "Nombre y Apellido": "Ana", Empresa: "braku sa", Contacto: "", Cumple: "15/3", "CUIL Contacto": "123" },
      { "Nombre y Apellido": "Diego Schneir", Empresa: "Grupo Piero", Contacto: "", Cumple: "", "CUIL Contacto": "" },
      { "Nombre y Apellido": "", Empresa: "Braku SA", Contacto: "", Cumple: "", "CUIL Contacto": "" },
    ],
    COMPANIES
  )

  it("makes one contact per person, linked to every company they appear under", () => {
    expect(parsed.contacts).toContainEqual({
      fullName: "Andrés Braun",
      phone: "11-5428-3796",
      email: "andres@braku.com",
      birthday: "19/09/1975",
      cuil: "20245605677",
      companyTaxIds: ["30710811160", "30712345678"],
    })
  })

  it("keeps what can be kept when a birthday or CUIL is incomplete", () => {
    expect(parsed.contacts).toContainEqual({ fullName: "Ana", phone: null, email: null, birthday: null, cuil: null, companyTaxIds: ["30710811160"] })
    expect(parsed.badBirthdays).toEqual([{ fullName: "Ana", value: "15/3" }])
  })

  it("reports the people whose company has no CUIT", () => {
    expect(parsed.withoutCompany).toEqual([{ fullName: "Diego Schneir", company: "Grupo Piero" }])
  })
})

describe("import helpers", () => {
  it("reads Excel birthdays and written ones", () => {
    expect(birthdayFrom(27656)).toBe("19/09/1975")
    expect(birthdayFrom("01/02/1980")).toBe("01/02/1980")
    expect(birthdayFrom("1/2")).toBeNull()
  })

  it("finds who an imported action was with", () => {
    expect(contactInDescription("Con Andrés Braun: le mandé la propuesta")).toEqual({ name: "Andrés Braun", rest: "le mandé la propuesta" })
    expect(contactInDescription("le mandé la propuesta")).toBeNull()
  })
})

describe("stepsNotLoaded", () => {
  it("leaves out the actions already loaded, even after their contact was taken out of the text", () => {
    const steps = [
      { date: "2026-05-19", description: "Con Ana: la llamé" },
      { date: "2026-05-26", description: "Con Ana: (sin detalle)" },
      { date: "2026-06-01", description: "Con Quique: abrió la cuenta" },
    ]
    const existing = [
      { date: "2026-05-19", description: "La llamé" },
      { date: "2026-05-26", description: "Con Ana: (sin detalle)" },
    ]
    expect(stepsNotLoaded(steps, existing).map((step) => step.date)).toEqual(["2026-06-01"])
  })
})

describe("foundContactRows", () => {
  it("brings the contact of each found row, naming rows without company after the contact", () => {
    expect(
      foundContactRows([
        { Empresa: "Selsa Group", Contacto: "Quique Chirom" },
        { Empresa: "#N/A", Contacto: "Gustavo Carranza" },
        { Empresa: "Chammas", Contacto: "" },
      ])
    ).toEqual([
      { "Nombre y Apellido": "Quique Chirom", Empresa: "Selsa Group" },
      { "Nombre y Apellido": "Gustavo Carranza", Empresa: "Gustavo Carranza" },
    ])
  })
})
