import XLSX from "xlsx"
import path from "path"
import { logger } from "@logger.js"
import { MISSING_CUIT_HEADERS, missingCuitRows } from "@domain/crmMissingCuits.js"

const USAGE = "Usage: pnpm crm:missing-cuits <crm.xlsx> [output.xlsx]"

const [input, output] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
if (!input) {
  logger.error(USAGE)
  process.exit(1)
}

const workbook = XLSX.readFile(input)
const listas = workbook.Sheets["Listas"]
const seguimiento = workbook.Sheets["Seguimiento"]
if (!listas || !seguimiento) throw new Error('The file needs the "Listas" and "Seguimiento" sheets')

const rows = missingCuitRows(
  XLSX.utils.sheet_to_json<Record<string, unknown>>(listas, { defval: "" }),
  XLSX.utils.sheet_to_json<Record<string, unknown>>(seguimiento, { defval: "" })
)

const sheet = XLSX.utils.json_to_sheet(rows, { header: [...MISSING_CUIT_HEADERS] })
sheet["!cols"] = [{ wch: 40 }, { wch: 28 }, { wch: 24 }, { wch: 44 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 40 }, { wch: 34 }]
sheet["!autofilter"] = { ref: sheet["!ref"]! }
const out = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(out, sheet, "Sin CUIT")
const target = output ?? path.join(path.dirname(path.resolve(input)), "Empresas sin CUIT.xlsx")
XLSX.writeFile(out, target)

logger.info(`${rows.length} companies without a usable CUIT, ${rows.filter((row) => Number(row["Acciones en Seguimiento"]) > 0).length} of them with history`)
logger.info(`Wrote ${target}`)
logger.info(`Next: pnpm crm:find-cuits "${target}"`)
