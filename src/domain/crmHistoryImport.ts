import { MAX_TEXT_LENGTH } from "@domain/crm.js"
import { isValidUsername } from "@domain/users.js"

export const NO_DETAIL = "(sin detalle)"

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000

export interface HistoryTask {
  description: string
  dueDate: string
  assignee: string
}

export interface HistoryStep {
  taxId: string
  businessName: string
  date: string
  description: string
  doneBy: string
  nextTask: HistoryTask | null
}

export interface ParsedHistory {
  byCompany: Map<string, HistoryStep[]>
  unknownCompanies: Map<string, number>
  withoutDate: number
  invalidNames: Set<string>
}

type Row = Record<string, unknown>

function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function clip(value: string): string {
  return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH - 1)}…` : value
}

export function excelDate(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return null
  return new Date(EXCEL_EPOCH_MS + Math.floor(value) * DAY_MS).toISOString().slice(0, 10)
}

export function nameKey(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().replace(/\s+/g, " ").toLowerCase()
}

export function usernameFor(name: string, aliases: ReadonlyMap<string, string>): string | null {
  const key = nameKey(name)
  if (key === "") return null
  const username = aliases.get(key) ?? key.replace(/ /g, ".")
  return isValidUsername(username) ? username : null
}

export function parseAliases(values: string[]): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const value of values) {
    const [name, username] = value.split("=")
    if (name && username) aliases.set(nameKey(name), username.trim().toLowerCase())
  }
  return aliases
}

export function companiesByContact(listRows: Row[]): Map<string, string> {
  const companies = new Map<string, string>()
  for (const row of listRows) {
    const contact = nameKey(text(row["Nombre y Apellido"]))
    const company = text(row["Empresa"])
    if (contact && company && !companies.has(contact)) companies.set(contact, company)
  }
  return companies
}

function isMissingCompany(name: string): boolean {
  return name === "" || name.startsWith("#")
}

export function parseHistory(
  rows: Row[],
  taxIdByCompany: ReadonlyMap<string, string>,
  aliases: ReadonlyMap<string, string>,
  fallbackUser: string,
  companyByContact: ReadonlyMap<string, string> = new Map()
): ParsedHistory {
  const result: ParsedHistory = { byCompany: new Map(), unknownCompanies: new Map(), withoutDate: 0, invalidNames: new Set() }
  const keyedCompanies = new Map([...taxIdByCompany].map(([name, taxId]) => [nameKey(name), { name, taxId }]))
  const collected = new Map<string, { order: number; step: HistoryStep }[]>()

  const user = (raw: unknown): string | null => {
    const name = text(raw)
    if (name === "") return null
    const username = usernameFor(name, aliases)
    if (username === null) result.invalidNames.add(name)
    return username
  }

  rows.forEach((row, index) => {
    if (text(row["Fecha Última Acción"]) === "" && text(row["Qué se hizo?"]) === "") return
    const written = text(row["Empresa"])
    const companyName = isMissingCompany(written) ? companyByContact.get(nameKey(text(row["Nombre"]))) ?? written : written
    if (companyName === "") return
    const company = keyedCompanies.get(nameKey(companyName))
    if (!company) {
      result.unknownCompanies.set(companyName, (result.unknownCompanies.get(companyName) ?? 0) + 1)
      return
    }
    const date = excelDate(row["Fecha Última Acción"])
    if (date === null) {
      result.withoutDate++
      return
    }
    const doneBy = user(row["Quién lo hizo"]) ?? fallbackUser
    const contact = text(row["Nombre"])
    const done = text(row["Qué se hizo?"]) || NO_DETAIL
    const dueDate = excelDate(row["Fecha Próxima Acción"])
    const nextTask =
      dueDate === null
        ? null
        : { description: clip(text(row["Qué hacer?"]) || NO_DETAIL), dueDate, assignee: user(row["Quién lo hará"]) ?? doneBy }

    const steps = collected.get(company.taxId) ?? []
    steps.push({
      order: index,
      step: {
        taxId: company.taxId,
        businessName: company.name,
        date,
        description: clip(contact ? `Con ${contact}: ${done}` : done),
        doneBy,
        nextTask,
      },
    })
    collected.set(company.taxId, steps)
  })

  for (const [taxId, steps] of collected) {
    steps.sort((a, b) => a.step.date.localeCompare(b.step.date) || a.order - b.order)
    result.byCompany.set(taxId, steps.map((entry) => entry.step))
  }
  return result
}

export function usersIn(history: ParsedHistory): Set<string> {
  const users = new Set<string>()
  for (const steps of history.byCompany.values()) {
    for (const step of steps) {
      users.add(step.doneBy)
      if (step.nextTask) users.add(step.nextTask.assignee)
    }
  }
  return users
}
