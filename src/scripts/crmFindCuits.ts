import "dotenv/config"
import XLSX from "xlsx"
import { logger } from "@logger.js"
import { NosisScraper, type NosisSearchResult } from "@scrapers/nosis.js"
import { formatCuit, searchableNames } from "@helpers/relationTree.js"
import { FOUND_STATUS, MISSING_CUIT_HEADERS, NOT_FOUND_STATUS, needsSearch, searchName } from "@domain/crmMissingCuits.js"

const USAGE = "Usage: pnpm crm:find-cuits <Empresas sin CUIT.xlsx> [--count N] [--retry]"

const args = process.argv.slice(2)
const file = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--count")
const countIndex = args.indexOf("--count")
const count = countIndex >= 0 ? Number(args[countIndex + 1]) : Infinity
const retry = args.includes("--retry")
if (!file || Number.isNaN(count) || count < 1) {
  logger.error(USAGE)
  process.exit(1)
}

function wait(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
  logger.info(`  waiting ${(ms / 1000).toFixed(0)}s before the next search...`)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function save(rows: Record<string, unknown>[]): void {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: [...MISSING_CUIT_HEADERS] })
  sheet["!cols"] = [{ wch: 40 }, { wch: 28 }, { wch: 24 }, { wch: 44 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 40 }, { wch: 34 }]
  sheet["!autofilter"] = { ref: sheet["!ref"]! }
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, "Sin CUIT")
  try {
    XLSX.writeFile(workbook, file!)
  } catch (err) {
    throw new Error(`Could not save ${file}. Close it in Excel and run again (what was found so far is lost only for this row). ${(err as Error).message}`)
  }
}

async function resolve(scraper: NosisScraper, name: string): Promise<NosisSearchResult | null> {
  for (const candidate of searchableNames(name)) {
    const identity = await scraper.searchByName(candidate)
    if (identity) return identity
  }
  return null
}

const workbook = XLSX.readFile(file)
const sheet = workbook.Sheets["Sin CUIT"] ?? workbook.Sheets[workbook.SheetNames[0]!]
if (!sheet) throw new Error("The file has no sheet to read")
const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" })
const pending = rows.filter((row) => needsSearch(row, retry)).slice(0, count)
logger.info(`${rows.length} rows, ${pending.length} to search in Nosis${retry ? " (retrying the ones not found)" : ""}`)
if (pending.length === 0) process.exit(0)

logger.info("Logging into Nosis...")
const scraper = await NosisScraper.create()
let found = 0

for (const [index, row] of pending.entries()) {
  const name = searchName(row)
  logger.info(`[${index + 1}/${pending.length}] ${name}`)
  try {
    const identity = await resolve(scraper, name)
    if (identity) {
      found++
      row["CUIT"] = identity.taxId
      row["Nombre en Nosis"] = identity.businessName
      row["Estado"] = FOUND_STATUS
      logger.info(`  → ${formatCuit(identity.taxId)} ${identity.businessName}`)
    } else {
      row["Estado"] = NOT_FOUND_STATUS
      logger.warn("  → not found")
    }
  } catch (err) {
    row["Estado"] = `Error: ${(err as Error).message}`
    logger.error(`  → ${(err as Error).message}`)
  }
  save(rows)
  if (index < pending.length - 1) await wait(10_000, 25_000)
}

logger.info(`Done: ${found} of ${pending.length} found. Check every "${FOUND_STATUS}" row: Nosis returns its first match by name.`)
logger.info(`Fill by hand the ones not found, then send the file back to load them.`)
