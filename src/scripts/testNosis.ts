import { NosisScraper } from "@scrapers/nosis.js"
import { logger } from "@logger"

/**
 * One-off CLI that exercises the Nosis scraper for a single Tax ID and
 * dumps the raw relationship tree to stdout.
 *
 * Used for manual debugging; not part of the loading pipeline.
 *
 * Usage:
 *   pnpm nosis:test <taxId>
 */
const taxId = process.argv[2]

if (!taxId) {
  console.error("Usage: pnpm nosis:test <taxId>")
  process.exit(1)
}

logger.info("Logging in...")
const scraper = await NosisScraper.create()

logger.info(`Resolving ${taxId}...`)
const identity = await scraper.searchAndResolve(taxId)

if (!identity) {
  logger.error(`No identity found for ${taxId}`)
  process.exit(1)
}

logger.info(`Scraping relationships for ${identity.taxId} (${identity.businessName})...`)
const relations = await scraper.fetchRelations(identity.taxId, identity.businessName)

logger.info(`Got ${relations.length} root nodes`)
console.log(JSON.stringify(relations, null, 2))