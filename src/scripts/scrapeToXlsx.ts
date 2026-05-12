/**
 * CLI script that reads an input Excel file with CUITs, scrapes each one
 * via Nosis, and writes a new Excel with the original rows plus the
 * relationship tree expanded into level-indexed columns.
 *
 * The tree is traversed recursively preserving parent-child hierarchy,
 * so each node appears directly below its parent in the output.
 *
 * Does NOT touch Neo4j — purely read-only against Nosis.
 *
 * Usage:
 *   pnpm tsx src/scripts/scrapeToXlsx.ts <inputPath> [outputPath] [startRow] [count]
 *
 * Examples:
 *   pnpm tsx src/scripts/scrapeToXlsx.ts ./sources/alyc.xlsx
 *   pnpm tsx src/scripts/scrapeToXlsx.ts ./sources/alyc.xlsx ./output/alyc-enriched.xlsx 1 50
 */

import "dotenv/config"
import XLSX from "xlsx"
import path from "path"
import { fileURLToPath } from "url"
import { logger } from "@logger"
import { NosisScraper } from "@scrapers/nosis.js"
import type { NosisRelation } from "@scrapers/nosis.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
  logger.info(`  Waiting ${(ms / 1000).toFixed(1)}s before next scrape...`)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeCuit(raw: unknown): string | null {
  if (raw == null) return null
  const digits = String(raw).replace(/\D/g, "")
  return digits.length === 11 ? digits : null
}

function formatCuit(taxId: string): string {
  return `${taxId.slice(0, 2)}-${taxId.slice(2, 10)}-${taxId.slice(10)}`
}

// ─── Tree flattening ──────────────────────────────────────────────────────────

interface FlatNode {
  taxId: string
  businessName: string
  relationshipType: string
  level: number
}

/**
 * Recursively traverses the NosisRelation tree in DFS pre-order.
 * Each child appears directly below its parent in the result array,
 * preserving the hierarchy so the output Excel is readable.
 */
function flattenChildren(children: NosisRelation[], level: number, result: FlatNode[]): void {
  for (const node of children) {
    result.push({
      taxId: node.taxId,
      businessName: node.businessName,
      relationshipType: node.relationshipType,
      level,
    })
    if (node.relations.length > 0) {
      flattenChildren(node.relations, level + 1, result)
    }
  }
}

function buildFlatTree(relations: NosisRelation[]): FlatNode[] {
  const result: FlatNode[] = []
  for (const root of relations) {
    // root is the searched CUIT itself — skip it, traverse its children
    flattenChildren(root.relations, 1, result)
  }
  return result
}

function renderNode(node: FlatNode): string {
  return `${formatCuit(node.taxId)} - ${node.businessName} - ${node.relationshipType}`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeToXlsx(
  inputPath: string,
  outputPath: string,
  startRow: number,
  count: number
): Promise<void> {
  logger.info(`Reading input file: ${inputPath}`)
  const wb = XLSX.readFile(inputPath)
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error("Input workbook has no sheets")
  const sheet = wb.Sheets[sheetName]
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`)

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })
  if (rows.length < 2) throw new Error("Input file has no data rows")

  const headerRow = rows[0] as string[]
  const dataRows = rows.slice(1)

  const cuitColIdx = headerRow.findIndex(
    (h) => String(h).trim().toLowerCase() === "cuit"
  )
  if (cuitColIdx === -1) throw new Error('Could not find a "CUIT" column in the header row')

  const slice = dataRows.slice(startRow - 1, startRow - 1 + count)
  logger.info(`Processing ${slice.length} rows (starting at row ${startRow})`)

  logger.info("Logging into Nosis...")
  const scraper = await NosisScraper.create()

  const enriched: { original: unknown[]; flat: FlatNode[] }[] = []
  let maxDepth = 0

  for (let i = 0; i < slice.length; i++) {
    const row = slice[i]!
    const rawCuit = row[cuitColIdx]
    const taxId = normalizeCuit(rawCuit)

    if (!taxId) {
      logger.warn(`Row ${startRow + i}: invalid CUIT "${String(rawCuit)}", skipping`)
      enriched.push({ original: row, flat: [] })
      continue
    }

    logger.info(`Row ${startRow + i}: scraping ${formatCuit(taxId)}...`)

    try {
      const relations = await scraper.scrape(taxId)
      const flat = buildFlatTree(relations)
      enriched.push({ original: row, flat })

      const depth = flat.reduce((m, n) => Math.max(m, n.level), 0)
      if (depth > maxDepth) maxDepth = depth
      logger.info(`  → ${flat.length} related nodes (max depth ${depth})`)
    } catch (err) {
      logger.error(`  → scrape failed: ${(err as Error).message}`)
      enriched.push({ original: row, flat: [] })
    }

    if (i < slice.length - 1) {
      await randomDelay(30_000, 90_000)
    }
  }

  logger.info("Building output workbook...")

  const levelHeaders = Array.from({ length: maxDepth }, (_, i) => `Nivel ${i + 1}`)
  const outputHeader = [...headerRow, ...levelHeaders]
  const outputRows: unknown[][] = [outputHeader]

  for (const { original, flat } of enriched) {
    const formattedOriginal = [...original]
    const taxId = normalizeCuit(original[cuitColIdx])
    if (taxId) formattedOriginal[cuitColIdx] = formatCuit(taxId)

    outputRows.push([...formattedOriginal, ...new Array(maxDepth).fill("")])

    for (const node of flat) {
      const levelCells = new Array(maxDepth).fill("")
      levelCells[node.level - 1] = renderNode(node)
      outputRows.push([...formattedOriginal, ...levelCells])
    }
  }

  const outSheet = XLSX.utils.aoa_to_sheet(outputRows)
  const outWb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(outWb, outSheet, "Enriched")
  XLSX.writeFile(outWb, outputPath)

  logger.info(`Done! Wrote ${outputRows.length - 1} data rows to: ${outputPath}`)
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

const inputPath = process.argv[2]

if (!inputPath) {
  console.error(
    "Usage: pnpm tsx src/scripts/scrapeToXlsx.ts <inputPath> [outputPath] [startRow] [count]"
  )
  process.exit(1)
}

const defaultOutput = path.join(
  path.dirname(path.resolve(inputPath)),
  `${path.basename(inputPath, path.extname(inputPath))}-enriched.xlsx`
)

const outputPath = process.argv[3] ?? defaultOutput
const startRow   = Number(process.argv[4] ?? 1)
const count      = Number(process.argv[5] ?? 1_000_000)

if (isNaN(startRow) || startRow < 1) {
  logger.error("startRow must be a positive number")
  process.exit(1)
}

if (isNaN(count) || count < 1) {
  logger.error("count must be a positive number")
  process.exit(1)
}

scrapeToXlsx(inputPath, outputPath, startRow, count).catch((err) => {
  logger.error(err)
  process.exit(1)
})
