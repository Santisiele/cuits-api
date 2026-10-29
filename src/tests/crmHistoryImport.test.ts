import { describe, it, expect } from "vitest"
import {
  NO_DETAIL,
  companiesByContact,
  excelDate,
  nameKey,
  parseAliases,
  parseHistory,
  responsibleFor,
  responsiblesIn,
} from "@domain/crmHistoryImport"

const ALIASES = parseAliases(["luc=Luchi", "diego w=Dieguito W", "broken"])
const COMPANIES = new Map([
  ["Braku SA", "30712345678"],
  ["Nam importaciones SA", "30798765432"],
])

function row(overrides: Record<string, unknown>) {
  return {
    Nombre: "",
    Empresa: "Braku SA",
    "Quién lo hizo": "Diego F",
    "Fecha Última Acción": 45833,
    "Qué se hizo?": "Llamé",
    "Fecha Próxima Acción": "",
    "Qué hacer?": "",
    "Quién lo hará": "",
    ...overrides,
  }
}

describe("excelDate", () => {
  it("turns a sheet day number into yyyy-mm-dd", () => {
    expect(excelDate(45833)).toBe("2025-06-25")
    expect(excelDate(45833.75)).toBe("2025-06-25")
  })

  it("refuses anything else", () => {
    expect(excelDate("")).toBeNull()
    expect(excelDate("23/06/2025")).toBeNull()
    expect(excelDate(0)).toBeNull()
  })
})

describe("responsibles from sheet names", () => {
  it("uses the alias when there is one, whatever the case or accents", () => {
    expect(responsibleFor("  LUC ", ALIASES)).toBe("Luchi")
    expect(responsibleFor("Diego W", ALIASES)).toBe("Dieguito W")
  })

  it("otherwise keeps the name as written, tidied", () => {
    expect(responsibleFor(" Tomi   J ", ALIASES)).toBe("Tomi J")
    expect(responsibleFor("Raúl", ALIASES)).toBe("Raúl")
    expect(nameKey(" Raúl ")).toBe("raul")
  })

  it("gives nothing for a blank or impossible name", () => {
    expect(responsibleFor(" ", ALIASES)).toBeNull()
    expect(responsibleFor("L", ALIASES)).toBeNull()
  })

  it("ignores malformed aliases", () => {
    expect(ALIASES.has("broken")).toBe(false)
  })
})

describe("parseHistory", () => {
  it("orders each company's actions by date and keeps the sheet order on ties", () => {
    const history = parseHistory(
      [
        row({ "Fecha Última Acción": 45840, "Qué se hizo?": "Tercera" }),
        row({ "Fecha Última Acción": 45833, "Qué se hizo?": "Primera" }),
        row({ "Fecha Última Acción": 45840, "Qué se hizo?": "Cuarta" }),
        row({ "Fecha Última Acción": 45835, "Qué se hizo?": "Segunda" }),
      ],
      COMPANIES,
      ALIASES,
      "admin"
    )
    expect(history.byCompany.get("30712345678")?.map((step) => step.description)).toEqual(["Primera", "Segunda", "Tercera", "Cuarta"])
  })

  it("builds the action and its next task, naming the contact and defaulting the assignee", () => {
    const history = parseHistory(
      [
        row({ Nombre: "Andrés Braun", "Fecha Próxima Acción": 45835, "Qué hacer?": "Coordinar", "Quién lo hará": "Mati" }),
        row({ "Qué se hizo?": "", "Fecha Próxima Acción": 45836, "Qué hacer?": "" }),
      ],
      COMPANIES,
      ALIASES,
      "admin"
    )
    expect(history.byCompany.get("30712345678")).toEqual([
      {
        taxId: "30712345678",
        businessName: "Braku SA",
        date: "2025-06-25",
        description: "Con Andrés Braun: Llamé",
        doneBy: "Diego F",
        nextTask: { description: "Coordinar", dueDate: "2025-06-27", assignee: "Mati" },
      },
      {
        taxId: "30712345678",
        businessName: "Braku SA",
        date: "2025-06-25",
        description: NO_DETAIL,
        doneBy: "Diego F",
        nextTask: { description: NO_DETAIL, dueDate: "2025-06-28", assignee: "Diego F" },
      },
    ])
  })

  it("matches company names loosely and counts what it cannot load", () => {
    const history = parseHistory(
      [
        row({ Empresa: "nam  IMPORTACIONES sa" }),
        row({ Empresa: "Sin CUIT SA" }),
        row({ Empresa: "Sin CUIT SA" }),
        row({ "Fecha Última Acción": "" }),
        row({ Empresa: "" }),
      ],
      COMPANIES,
      ALIASES,
      "admin"
    )
    expect(history.byCompany.get("30798765432")).toHaveLength(1)
    expect(history.unknownCompanies).toEqual(new Map([["Sin CUIT SA", 2]]))
    expect(history.withoutDate).toBe(1)
  })

  it("falls back when the name is blank or unusable, and reports the unusable one", () => {
    const history = parseHistory([row({ "Quién lo hizo": "" }), row({ "Quién lo hizo": "L" })], COMPANIES, ALIASES, "Sol")
    expect(history.byCompany.get("30712345678")?.map((step) => step.doneBy)).toEqual(["Sol", "Sol"])
    expect([...history.invalidNames]).toEqual(["L"])
  })

  it("clips text longer than the API accepts", () => {
    const history = parseHistory([row({ "Qué se hizo?": "x".repeat(2500) })], COMPANIES, ALIASES, "admin")
    expect(history.byCompany.get("30712345678")?.[0]?.description).toHaveLength(2000)
  })

  it("recovers the company of a broken #N/A cell from the contact in Listas", () => {
    const byContact = companiesByContact([
      { "Nombre y Apellido": "Nicolás Romano", Empresa: "Nam importaciones SA" },
      { "Nombre y Apellido": "Nicolás Romano", Empresa: "Otra SA" },
      { "Nombre y Apellido": "", Empresa: "Braku SA" },
    ])
    const history = parseHistory(
      [row({ Empresa: "#N/A", Nombre: "nicolas romano" }), row({ Empresa: "#N/A", Nombre: "Nadie" })],
      COMPANIES,
      ALIASES,
      "admin",
      byContact
    )
    expect(history.byCompany.get("30798765432")).toHaveLength(1)
    expect(history.unknownCompanies).toEqual(new Map([["#N/A", 1]]))
  })

  it("lists every responsible who acts or gets a task", () => {
    const history = parseHistory(
      [row({ "Fecha Próxima Acción": 45835, "Quién lo hará": "Raul" }), row({ "Quién lo hizo": "Flavia" })],
      COMPANIES,
      ALIASES,
      "admin"
    )
    expect([...responsiblesIn(history)].sort()).toEqual(["Diego F", "Flavia", "Raul"])
  })
})
