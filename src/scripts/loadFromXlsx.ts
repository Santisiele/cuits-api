import XLSX from "xlsx"
import path from "path"
import { fileURLToPath } from "url"
import neo4j from "neo4j-driver"
import { config } from "@config"
import { NosisScraper } from "@scrapers/nosis"
import { mapToGraph } from "@scrapers/nosisMapper"
import { insertGraphData } from "@scrapers/nosisNeo4j"
import { logger } from "@logger"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CUIT_REGEX = /^\d{2}-\d{8}-\d{1}$/

/**
 * Returns a random delay between 30 and 90 seconds
 */
function randomDelay(): number {
  return Math.floor(Math.random() * (90000 - 30000 + 1)) + 30000
}

/**
 * Strips dashes from a CUIT string
 */
function stripDashes(cuit: string): string {
  return cuit.replace(/-/g, "")
}

/**
 * Loads CUITs from an xlsx file into Neo4j with Nosis scraping
 * @param filePath - Path to the xlsx file
 * @param startRow - Row to start from (1-based, excluding header)
 * @param count - Number of CUITs to process
 */
async function loadFromXlsx(filePath: string, startRow: number, count: number) {
  // Read xlsx
  const workbook = XLSX.readFile(filePath)
  const sheet = workbook.Sheets[workbook.SheetNames[0]!]!
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet)

  const validRows = rows.filter((row) => {
    const cuit = String(row["CUIT"] ?? "").trim()
    return CUIT_REGEX.test(cuit)
  })

  logger.info(`Total valid CUITs in file: ${validRows.length}`)

  const toProcess = validRows.slice(startRow - 1, startRow - 1 + count)

  logger.info(`Processing ${toProcess.length} CUITs starting from row ${startRow}`)

  const driver = neo4j.driver(
    config.neo4j.uri,
    neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
  )

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
      const session = driver.session()
      try {
        await session.run(
          `
          MERGE (c:CUIT {id: $id})
          SET c.businessName = $name,
              c.inMyBase = true,
              c.source = "xlsx-poseidon"
          `,
          { id: cuitClean, name }
        )
      } finally {
        await session.close()
      }

      const relations = await scraper.scrape(cuitClean)
      logger.info(`Scraped ${relations.length} relations for ${cuitClean}`)
      const graphData = mapToGraph(relations)
      await insertGraphData(graphData)

      logger.info(`✓ Loaded ${graphData.nodes.length} nodes, ${graphData.relationships.length} relationships`)
    } catch (error) {
      logger.error(`✗ Failed for ${cuitClean}: ${error instanceof Error ? error.message : error}`)
    }

    if (i < toProcess.length - 1) {
      const delay = randomDelay()
      logger.info(`Waiting ${Math.round(delay / 1000)}s before next...`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  await driver.close()
  logger.info("Done!")
}

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