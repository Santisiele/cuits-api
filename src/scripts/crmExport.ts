import "dotenv/config"
import XLSX from "xlsx"
import path from "path"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { crmExportSheets, type CompanyHistory, type ExportSheet } from "@domain/crmExport.js"

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000
const EXCEL_EPOCH_OFFSET = 25_569
const DATE_FORMAT = "dd/mm/yyyy"
const WIDTHS: Record<string, number> = {
  Empresa: 34,
  CUIT: 13,
  "Con quién": 24,
  "Qué se hizo": 60,
  "Qué hacer": 40,
  Detalle: 70,
  "Nombre y apellido": 28,
  Email: 28,
  "Motivo de cierre": 30,
  "Producto o servicio": 24,
}

function cell(value: unknown, isDate: boolean): unknown {
  const match = isDate && typeof value === "string" ? ISO_DATE.exec(value) : null
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS + EXCEL_EPOCH_OFFSET : value
}

function toWorksheet(sheet: ExportSheet): XLSX.WorkSheet {
  const dates = new Set(sheet.dateColumns)
  const rows = sheet.rows.map((row) => Object.fromEntries(sheet.header.map((column) => [column, cell(row[column], dates.has(column))])))
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: sheet.header })
  sheet.header.forEach((column, col) => {
    if (!dates.has(column)) return
    rows.forEach((_, index) => {
      const target = worksheet[XLSX.utils.encode_cell({ r: index + 1, c: col })]
      if (target?.t === "n") target.z = DATE_FORMAT
    })
  })
  worksheet["!cols"] = sheet.header.map((column) => ({ wch: WIDTHS[column] ?? Math.max(12, column.length + 2) }))
  if (worksheet["!ref"]) worksheet["!autofilter"] = { ref: worksheet["!ref"] }
  return worksheet
}

async function main(): Promise<void> {
  const [output] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" })
  const repository = new Neo4jCrmRepository()

  try {
    const companies = await repository.listCompanies()
    const histories: CompanyHistory[] = []
    for (const [index, company] of companies.entries()) {
      const [actions, tasks, contacts] = await Promise.all([
        repository.listActions(company.taxId),
        repository.listTasks(company.taxId),
        repository.listContacts(company.taxId),
      ])
      histories.push({ company, actions, tasks, contacts })
      if ((index + 1) % 50 === 0) logger.info(`Read ${index + 1}/${companies.length} companies`)
    }

    const book = XLSX.utils.book_new()
    const sheets = crmExportSheets(histories, today)
    for (const sheet of sheets) XLSX.utils.book_append_sheet(book, toWorksheet(sheet), sheet.name)
    const target = path.resolve(output ?? `CRM ${today}.xlsx`)
    XLSX.writeFile(book, target)

    for (const sheet of sheets) logger.info(`${sheet.name}: ${sheet.rows.length} rows`)
    logger.info(`Wrote ${target}`)
  } finally {
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
