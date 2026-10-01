import "dotenv/config"
import XLSX from "xlsx"
import path from "path"
import { logger } from "@logger.js"
import { NosisScraper, type NosisSearchResult } from "@scrapers/nosis.js"
import {
  buildFlatTree,
  formatCuit,
  levelRows,
  maxLevel,
  searchableNames,
  type FlatNode,
} from "@helpers/relationTree.js"

const HEADER_NAMES = /^(empresas?|raz[oó]n social|nombre|denominaci[oó]n)$/i

interface Company {
  name: string
  identity: NosisSearchResult | null
  flat: FlatNode[]
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
  logger.info(`  Waiting ${(ms / 1000).toFixed(1)}s before next scrape...`)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readNames(inputPath: string, column: string): string[] {
  const wb = XLSX.readFile(inputPath)
  const sheetName = wb.SheetNames[0]
  const sheet = sheetName ? wb.Sheets[sheetName] : undefined
  if (!sheet?.["!ref"]) throw new Error("Input workbook has no data")

  const col = XLSX.utils.decode_col(column)
  const range = XLSX.utils.decode_range(sheet["!ref"])
  const names: string[] = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cell = sheet[XLSX.utils.encode_cell({ r, c: col })]
    const name = String(cell?.v ?? "").trim()
    if (!name) continue
    if (names.length === 0 && HEADER_NAMES.test(name)) continue
    names.push(name)
  }
  return names
}

async function resolve(scraper: NosisScraper, name: string): Promise<NosisSearchResult | null> {
  for (const candidate of searchableNames(name)) {
    const identity = await scraper.searchByName(candidate)
    if (identity) return identity
  }
  return null
}

async function scrapeNamesToXlsx(
  inputPath: string,
  outputPath: string,
  column: string,
  startRow: number,
  count: number
): Promise<void> {
  logger.info(`Reading company names from column ${column} of ${inputPath}`)
  const names = readNames(inputPath, column)
  if (names.length === 0) throw new Error(`Column ${column} has no company names`)

  const slice = names.slice(startRow - 1, startRow - 1 + count)
  logger.info(`Processing ${slice.length} of ${names.length} companies (starting at ${startRow})`)

  logger.info("Logging into Nosis...")
  const scraper = await NosisScraper.create()

  const companies: Company[] = []
  for (let i = 0; i < slice.length; i++) {
    const name = slice[i]!
    logger.info(`${startRow + i}/${names.length}: searching "${name}"...`)

    try {
      const identity = await resolve(scraper, name)
      if (!identity) {
        logger.warn("  → not found in Nosis")
        companies.push({ name, identity: null, flat: [] })
        continue
      }
      logger.info(`  → ${formatCuit(identity.taxId)} ${identity.businessName}`)
      const relations = await scraper.fetchRelations(identity.taxId, identity.businessName)
      const flat = buildFlatTree(relations)
      companies.push({ name, identity, flat })
      logger.info(`  → ${flat.length} related nodes (max depth ${maxLevel(flat)})`)
    } catch (err) {
      logger.error(`  → scrape failed: ${(err as Error).message}`)
      companies.push({ name, identity: null, flat: [] })
    }

    if (i < slice.length - 1) {
      await randomDelay(30_000, 90_000)
    }
  }

  const depth = companies.reduce((max, c) => Math.max(max, maxLevel(c.flat)), 0)
  const levelHeaders = Array.from({ length: depth }, (_, i) => `Nivel ${i + 1}`)
  const outputRows: unknown[][] = [["CUIT", "Empresa", ...levelHeaders]]
  for (const { name, identity, flat } of companies) {
    const cuit = identity ? formatCuit(identity.taxId) : ""
    outputRows.push(...levelRows([cuit, name], flat, depth))
  }

  const outSheet = XLSX.utils.aoa_to_sheet(outputRows)
  const outWb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(outWb, outSheet, "Enriched")
  XLSX.writeFile(outWb, outputPath)

  logger.info("Matches, check the names differ only in spelling:")
  for (const { name, identity } of companies) {
    logger.info(`  ${name} → ${identity ? `${formatCuit(identity.taxId)} ${identity.businessName}` : "NOT FOUND"}`)
  }
  logger.info(`Done! Wrote ${outputRows.length - 1} data rows to: ${outputPath}`)
}

const args = process.argv.slice(2)
const columnArg = args.find((a) => a.startsWith("--column="))
const positional = args.filter((a) => !a.startsWith("--"))
const inputPath = positional[0]

if (!inputPath) {
  console.error(
    "Usage: pnpm scrape:names <inputPath> [outputPath] [startRow] [count] [--column=B]"
  )
  process.exit(1)
}

const defaultOutput = path.join(
  path.dirname(path.resolve(inputPath)),
  `${path.basename(inputPath, path.extname(inputPath))}-enriched.xlsx`
)

const outputPath = positional[1] ?? defaultOutput
const startRow = Number(positional[2] ?? 1)
const count = Number(positional[3] ?? 1_000_000)
const column = (columnArg?.split("=")[1] ?? "B").toUpperCase()

if (!/^[A-Z]{1,3}$/.test(column)) {
  logger.error("--column must be a column letter, like B")
  process.exit(1)
}

if (isNaN(startRow) || startRow < 1) {
  logger.error("startRow must be a positive number")
  process.exit(1)
}

if (isNaN(count) || count < 1) {
  logger.error("count must be a positive number")
  process.exit(1)
}

scrapeNamesToXlsx(inputPath, outputPath, column, startRow, count).catch((err) => {
  logger.error(err)
  process.exit(1)
})
