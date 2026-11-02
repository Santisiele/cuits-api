import { parseCompanyList, type ImportedCompany } from "@domain/crmImport.js"
import { companiesByContact, excelDate, nameKey } from "@domain/crmHistoryImport.js"

type Row = Record<string, unknown>

export const MISSING_CUIT_HEADERS = [
  "Empresa",
  "Contacto",
  "Motivo",
  "Acciones en Seguimiento",
  "Última acción",
  "Próxima acción",
  "CUIT",
  "Nombre en Nosis",
  "Estado",
] as const

export type MissingCuitRow = Record<(typeof MISSING_CUIT_HEADERS)[number], string | number>

export const FOUND_STATUS = "Encontrado: revisar que sea la misma"
export const NOT_FOUND_STATUS = "No encontrado"

function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function day(serial: unknown): string {
  const iso = excelDate(serial)
  return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : ""
}

interface Activity {
  count: number
  last: string | null
  lastSerial: unknown
  nextSerial: unknown
  contact: string
}

function activityByCompany(seguimiento: readonly Row[], byContact: ReadonlyMap<string, string>): Map<string, Activity & { name: string }> {
  const activity = new Map<string, Activity & { name: string }>()
  for (const row of seguimiento) {
    const written = text(row["Empresa"])
    const name = written === "" || written.startsWith("#") ? byContact.get(nameKey(text(row["Nombre"]))) ?? written : written
    if (name === "" || (text(row["Fecha Última Acción"]) === "" && text(row["Qué se hizo?"]) === "")) continue
    const key = nameKey(name)
    const entry = activity.get(key) ?? { name, count: 0, last: null, lastSerial: "", nextSerial: "", contact: "" }
    entry.count++
    const date = excelDate(row["Fecha Última Acción"])
    if (date !== null && (entry.last === null || date >= entry.last)) {
      entry.last = date
      entry.lastSerial = row["Fecha Última Acción"]
      entry.nextSerial = row["Fecha Próxima Acción"]
    }
    if (!entry.contact) entry.contact = text(row["Nombre"])
    activity.set(key, entry)
  }
  return activity
}

function contactsByCompany(listas: readonly Row[]): Map<string, string> {
  const contacts = new Map<string, string>()
  for (const row of listas) {
    const key = nameKey(text(row["Empresa"]))
    const contact = text(row["Nombre y Apellido"])
    if (key && contact && !contacts.has(key)) contacts.set(key, contact)
  }
  return contacts
}

export function missingCuitRows(listas: readonly Row[], seguimiento: readonly Row[]): MissingCuitRow[] {
  const parsed = parseCompanyList([...listas])
  const activity = activityByCompany(seguimiento, companiesByContact([...listas]))
  const contacts = contactsByCompany(listas)
  const inListas = new Set(listas.map((row) => nameKey(text(row["Empresa"]))).filter(Boolean))

  const row = (name: string, reason: string, cuit = ""): MissingCuitRow => {
    const seen = activity.get(nameKey(name))
    return {
      Empresa: name,
      Contacto: contacts.get(nameKey(name)) || seen?.contact || "",
      Motivo: reason,
      "Acciones en Seguimiento": seen?.count ?? 0,
      "Última acción": seen ? day(seen.lastSerial) : "",
      "Próxima acción": seen ? day(seen.nextSerial) : "",
      CUIT: cuit,
      "Nombre en Nosis": "",
      Estado: "",
    }
  }

  const rows = [
    ...parsed.withoutCuit.map((name) => row(name, "Sin CUIT en Listas")),
    ...parsed.invalidCuit.map(({ businessName, cuit }) => row(businessName, `CUIT mal escrito en Listas: ${cuit}`)),
    ...parsed.conflicting.map(({ businessName, cuits }) =>
      row(businessName, cuits.length > 1 ? `Varios CUIT en Listas: ${cuits.join(", ")}` : `CUIT repetido con otra empresa: ${cuits[0]}`)
    ),
    ...[...activity.values()]
      .filter((entry) => !inListas.has(nameKey(entry.name)))
      .map((entry) => row(entry.name, entry.name.startsWith("#") ? "Fila de Seguimiento sin empresa (buscar por contacto)" : "Está en Seguimiento pero no en Listas")),
  ]
  return rows.sort(
    (a, b) => Number(b["Acciones en Seguimiento"]) - Number(a["Acciones en Seguimiento"]) || String(a.Empresa).localeCompare(String(b.Empresa), "es")
  )
}

export function needsSearch(row: Partial<Record<string, unknown>>, retry: boolean): boolean {
  if (text(row["CUIT"]).replace(/\D/g, "").length === 11) return false
  if (text(row["Empresa"]).startsWith("#")) return false
  const status = text(row["Estado"])
  if (status === "") return true
  return retry && status !== FOUND_STATUS
}

export interface FoundCompanies {
  companies: ImportedCompany[]
  skipped: { name: string; reason: string }[]
  taxIdByCompany: Map<string, string>
  companyByContact: Map<string, string>
}

function listFields(listas: readonly Row[], name: string): Pick<ImportedCompany, "crmBrand" | "crmProduct" | "crmOrigin"> {
  const rows = listas.filter((row) => nameKey(text(row["Empresa"])) === nameKey(name))
  const joined = (column: string): string | null => {
    const values = [...new Set(rows.map((row) => text(row[column])).filter(Boolean))]
    return values.length === 0 ? null : values.join(" / ")
  }
  return { crmBrand: joined("Marca"), crmProduct: joined("Producto o Servicio"), crmOrigin: joined("Origen") }
}

export function foundCompanies(found: readonly Row[], listas: readonly Row[]): FoundCompanies {
  const result: FoundCompanies = {
    companies: [],
    skipped: [],
    taxIdByCompany: new Map(),
    companyByContact: companiesByContact([...listas]),
  }
  const taken = new Map<string, string>()
  for (const row of found) {
    const written = text(row["Empresa"])
    const contact = text(row["Contacto"])
    const withoutCompany = written === "" || written.startsWith("#")
    const name = withoutCompany ? contact : written
    if (!name) continue
    const taxId = text(row["CUIT"]).replace(/\D/g, "")
    if (taxId.length !== 11) {
      result.skipped.push({ name, reason: taxId ? `CUIT mal escrito: ${taxId}` : "sin CUIT" })
      continue
    }
    const first = taken.get(taxId)
    result.taxIdByCompany.set(name, taxId)
    if (withoutCompany) result.companyByContact.set(nameKey(contact), name)
    if (first) {
      result.skipped.push({ name, reason: `mismo CUIT que ${first}, su historial va a esa empresa` })
      continue
    }
    taken.set(taxId, name)
    result.companies.push({ taxId, businessName: text(row["Nombre en Nosis"]) || name, ...listFields(listas, written) })
  }
  return result
}
