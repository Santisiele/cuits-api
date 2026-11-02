import type { ImportedCompany } from "@domain/crmImport.js"
import { nameKey } from "@domain/crmHistoryImport.js"

type Row = Record<string, unknown>

export const REMOVED_REASON = "Estaba en la hoja Eliminados del Excel"

const SEGUIMIENTO_COLUMNS = ["Nombre", "Empresa", "Quién lo hizo", "Fecha Última Acción", "Qué se hizo?", "Fecha Próxima Acción", "Qué hacer?", "Quién lo hará"] as const

export interface RemovedSheet {
  companies: ImportedCompany[]
  taxIdByCompany: Map<string, string>
  seguimiento: Row[]
  listas: Row[]
  withoutCuit: string[]
}

function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function displayName(name: string): string {
  return name === name.toUpperCase() ? name.toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase()) : name
}

export function parseRemovedSheet(rows: readonly unknown[][], cuitByCompany: ReadonlyMap<string, string>): RemovedSheet {
  const result: RemovedSheet = { companies: [], taxIdByCompany: new Map(), seguimiento: [], listas: [], withoutCuit: [] }
  const overrides = new Map([...cuitByCompany].map(([name, cuit]) => [nameKey(name), cuit.replace(/\D/g, "")]))
  const companies = new Map<string, ImportedCompany>()

  for (const row of rows) {
    const company = text(row[1])
    if (!company) continue
    result.seguimiento.push(Object.fromEntries(SEGUIMIENTO_COLUMNS.map((column, index) => [column, row[index] ?? ""])))
    const contact = text(row[0])
    if (contact) result.listas.push({ "Nombre y Apellido": contact, Empresa: company, Contacto: row[14] ?? "", Cumple: row[12] ?? "", "CUIL Contacto": "" })
    const taxId = overrides.get(nameKey(company)) ?? text(row[9]).replace(/\D/g, "")
    if (taxId.length !== 11) {
      if (!result.withoutCuit.includes(company)) result.withoutCuit.push(company)
      continue
    }
    result.taxIdByCompany.set(company, taxId)
    if (!companies.has(company)) {
      companies.set(company, {
        taxId,
        businessName: displayName(company),
        crmBrand: text(row[10]) || null,
        crmProduct: text(row[11]) || null,
        crmOrigin: text(row[13]) || null,
      })
    }
  }
  result.companies = [...companies.values()]
  return result
}
