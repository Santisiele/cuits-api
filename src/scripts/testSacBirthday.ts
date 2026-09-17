import "dotenv/config"
import { SacScraper } from "@scrapers/nosisSac.js"
import { logger } from "@logger.js"

const document = process.argv[2]

if (!document) {
  console.error("Usage: pnpm sac:test <documento>")
  process.exit(1)
}

logger.info("Logging in...")
const scraper = await SacScraper.create()

logger.info(`Resolving ${document}...`)
const identity = await scraper.searchDocument(document)
if (!identity) {
  logger.error(`No identity found for ${document}`)
  process.exit(1)
}
logger.info(`Resolved to ${identity.taxId} (${identity.businessName})`)

const birthday = await scraper.fetchBirthday(identity.taxId, identity.businessName)
if (birthday) {
  logger.info(`Birthday: ${birthday}`)
} else {
  logger.warn("No birthday found in the Verificación de Identidad block")
}
process.exit(0)
