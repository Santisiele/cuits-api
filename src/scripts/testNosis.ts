import { NosisScraper } from "@scrapers/nosis"
import { mapToGraph } from "@scrapers/nosisMapper"
import { insertGraphData } from "@scrapers/nosisNeo4j"
import { logger } from "@logger"

const taxId = process.argv[2]

if (!taxId) {
  console.error("Usage: pnpm nosis:test <taxId>")
  process.exit(1)
}

logger.info("Logging in...")
const scraper = await NosisScraper.create()

logger.info(`Scraping Tax ID ${taxId}...`)
const relations = await scraper.scrape(taxId)

logger.info("Mapping to graph...")
const graphData = mapToGraph(relations)
logger.info(`Nodes: ${graphData.nodes.length}, Relationships: ${graphData.relationships.length}`)

logger.info("Inserting into Neo4j...")
await insertGraphData(graphData)

logger.info("Done!")