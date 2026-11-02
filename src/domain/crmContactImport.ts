import { excelDate, nameKey } from "@domain/crmHistoryImport.js"
import { isValidBirthday } from "@domain/crm.js"

type Row = Record<string, unknown>

export interface ImportedContact {
  fullName: string
  phone: string | null
  email: string | null
  birthday: string | null
  cuil: string | null
  companyTaxIds: string[]
}

export interface ParsedContacts {
  contacts: ImportedContact[]
  withoutCompany: { fullName: string; company: string }[]
  badBirthdays: { fullName: string; value: string }[]
}

function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

export function birthdayFrom(value: unknown): string | null {
  if (typeof value === "number") {
    const iso = excelDate(value)
    return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null
  }
  const written = text(value)
  return isValidBirthday(written) ? written : null
}

export function parseListasContacts(listas: readonly Row[], taxIdByCompany: ReadonlyMap<string, string>): ParsedContacts {
  const keyed = new Map([...taxIdByCompany].map(([name, taxId]) => [nameKey(name), taxId]))
  const byPerson = new Map<string, ImportedContact>()
  const result: ParsedContacts = { contacts: [], withoutCompany: [], badBirthdays: [] }

  for (const row of listas) {
    const fullName = text(row["Nombre y Apellido"])
    const company = text(row["Empresa"])
    if (!fullName) continue
    const taxId = keyed.get(nameKey(company))
    if (!taxId) {
      result.withoutCompany.push({ fullName, company })
      continue
    }
    const reach = text(row["Contacto"])
    const rawBirthday = row["Cumple"]
    const birthday = birthdayFrom(rawBirthday)
    if (birthday === null && text(rawBirthday) !== "") result.badBirthdays.push({ fullName, value: text(rawBirthday) })
    const cuil = text(row["CUIL Contacto"]).replace(/\D/g, "")

    const key = nameKey(fullName)
    const contact = byPerson.get(key) ?? { fullName, phone: null, email: null, birthday: null, cuil: null, companyTaxIds: [] }
    if (!contact.companyTaxIds.includes(taxId)) contact.companyTaxIds.push(taxId)
    if (reach.includes("@")) contact.email ??= reach
    else if (reach) contact.phone ??= reach
    contact.birthday ??= birthday
    if (cuil.length === 11) contact.cuil ??= cuil
    byPerson.set(key, contact)
  }
  result.contacts = [...byPerson.values()]
  return result
}

const WITH_PREFIX = /^Con ([^:]+):\s*([\s\S]*)$/

export function contactInDescription(description: string): { name: string; rest: string } | null {
  const match = WITH_PREFIX.exec(description)
  return match ? { name: match[1]!.trim(), rest: match[2]! } : null
}
