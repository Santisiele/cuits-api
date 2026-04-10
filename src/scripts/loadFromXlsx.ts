import XLSX from "xlsx"
import path from "path"
import { fileURLToPath } from "url"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import { NosisScraper } from "@scrapers/nosis.js"
import { mapToGraph } from "@scrapers/nosisMapper.js"
import { insertGraphData } from "@scrapers/nosisNeo4j.js"
import { logger } from "@logger.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─── Constants ────────────────────────────────────────────────────────────────

const CUIT_REGEX = /^\d{2}-\d{8}-\d{1}$/
const MIN_DELAY_MS = 30_000
const MAX_DELAY_MS = 90_000

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns a random delay between {@link MIN_DELAY_MS} and {@link MAX_DELAY_MS} ms. */
function randomDelayMs(): number {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS
}

/** Removes dashes from a CUIT string. */
function stripDashes(cuit: string): string {
  return cuit.replace(/-/g, "")
}

/** Waits for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Loads CUITs from an xlsx file into Neo4j, scraping Nosis for each one.
 *
 * Changes from the original:
 * - Uses the shared {@link Neo4jDriver} singleton instead of creating
 *   a new driver and session per CUIT — eliminates connection leaks
 * - Session is opened once per CUIT and closed immediately after the
 *   base node upsert, before the (potentially slow) Nosis scrape
 *
 * @param filePath - Path to the xlsx file
 * @param startRow - 1-based row index to start from (excluding header)
 * @param count - Number of CUITs to process
 */
async function loadFromXlsx(filePath: string, startRow: number, count: number): Promise<void> {
  const workbook = XLSX.readFile(filePath)
  const sheet = workbook.Sheets[workbook.SheetNames[0]!]!
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet)

  const validRows = rows.filter((row) => CUIT_REGEX.test(String(row["CUIT"] ?? "").trim()))
  logger.info(`Total valid CUITs in file: ${validRows.length}`)

  const toProcess = validRows.slice(startRow - 1, startRow - 1 + count)
  logger.info(`Processing ${toProcess.length} CUITs starting from row ${startRow}`)

  logger.info("Logging in to Nosis...")
  const scraper = await NosisScraper.create()
  logger.info("Logged in successfully")

  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i]!
    const cuitWithDashes = String(row["CUIT"]).trim()
    const cuitClean = stripDashes(cuitWithDashes)
    const name = String(row["Nombre completo"] ?? "").trim()

    logger.info(`[${i + 1}/${toProcess.length}] Processing ${name} (${cuitClean})`)

    try {
      // Upsert the base node — open a dedicated session, close immediately
      const session = Neo4jDriver.instance.session()
      try {
        await session.run(Queries.MERGE_BASE_NODE, {
          id: cuitClean,
          name,
          source: "xlsx-poseidon",
        })
      } finally {
        await session.close()
      }

      // Scrape and insert relationships (uses its own session internally)
      const relations = await scraper.scrape(cuitClean)
      logger.info(`Scraped ${relations.length} relations for ${cuitClean}`)
      const graphData = mapToGraph(relations)
      await insertGraphData(graphData)

      logger.info(`✓ Loaded ${graphData.nodes.length} nodes, ${graphData.relationships.length} relationships`)
    } catch (error) {
      logger.error(`✗ Failed for ${cuitClean}: ${error instanceof Error ? error.message : error}`)
    }

    if (i < toProcess.length - 1) {
      const delay = randomDelayMs()
      logger.info(`Waiting ${Math.round(delay / 1000)}s before next...`)
      await sleep(delay)
    }
  }

  await Neo4jDriver.close()
  logger.info("Done!")
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

const filePath = process.argv[2] ?? path.join(__dirname, "../../sources/Filled-dbPoseidon.xlsx")
const startRow = Number(process.argv[3] ?? 1)
const count = Number(process.argv[4] ?? 10)

if (isNaN(startRow) || startRow < 1) {
  logger.error("startRow must be a positive number")
  process.exit(1)
}

if (isNaN(count) || count < 1) {
  logger.error("count must be a positive number")
  process.exit(1)
}

loadFromXlsx(filePath, startRow, count).catch((err) => {
  logger.error(err)
  process.exit(1)
})