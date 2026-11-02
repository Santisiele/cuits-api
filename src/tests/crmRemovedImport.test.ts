import { describe, it, expect } from "vitest"
import { parseRemovedSheet } from "@domain/crmRemovedImport"

const ROWS = [
  ["Moi Groisman", "IBM ARGENTINA", "Diego F", 46117, "Alejandro comentó", 46119, "Por qué no con nosotros?", "Diego F", "x", "30-50396126-8", "", "Tecnología", "", "Amigo", "11-6179-2049"],
  ["Valentin Cohen", "NITO TEXTIL", "Mati", 45908, "Tiene lindos cheques", 45950, "Ver si firmó", "Mati", "x", "", "", "", "", "", ""],
  ["Nadie", "SIN CUIT SA", "Mati", 45908, "x", "", "", "", "", "", "", "", "", "", ""],
]

describe("parseRemovedSheet", () => {
  const parsed = parseRemovedSheet(ROWS, new Map([["Nito Textil", "30-71789385-5"]]))

  it("reads each removed company with the CUIT of the sheet or the one given", () => {
    expect(parsed.companies).toEqual([
      { taxId: "30503961268", businessName: "Ibm Argentina", crmBrand: null, crmProduct: "Tecnología", crmOrigin: "Amigo" },
      { taxId: "30717893855", businessName: "Nito Textil", crmBrand: null, crmProduct: null, crmOrigin: null },
    ])
    expect(parsed.withoutCuit).toEqual(["SIN CUIT SA"])
  })

  it("turns the rows into history and contacts in the shape of Seguimiento and Listas", () => {
    expect(parsed.seguimiento[0]).toMatchObject({ Nombre: "Moi Groisman", Empresa: "IBM ARGENTINA", "Qué se hizo?": "Alejandro comentó" })
    expect(parsed.listas[0]).toMatchObject({ "Nombre y Apellido": "Moi Groisman", Empresa: "IBM ARGENTINA", Contacto: "11-6179-2049" })
    expect(parsed.taxIdByCompany.get("NITO TEXTIL")).toBe("30717893855")
  })
})
