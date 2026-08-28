import "dotenv/config"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jRepository } from "@infrastructure/neo4j/Neo4jRepository.js"
import { DeudoresLoader } from "@infrastructure/loaders/DeudoresFinancieraLoader.js"
import { LoaderService } from "@application/LoaderService.js"

/**
 * Driving adapter (CLI) for the "Deudores por financiera" source.
 *
 * No enricher is passed to LoaderService → no Nosis calls, no throttling.
 * Rows are pre-aggregated by debtor CUIT inside the loader, so the number
 * of LoadableRows the service processes equals the number of unique
 * debtors in the file, not the row count.
 *
 * Usage:
 *   pnpm tsx src/scripts/loadFromDeudores.ts <inputPath> [startRow] [count]
 *
 * Example:
 *   pnpm tsx src/scripts/loadFromDeudores.ts ./sources/toKnow/deudoresFinanciera.xlsx
 */
async function main(): Promise<void> {
  const inputPath = process.argv[2]
  if (!inputPath) {
    throw new Error("Usage: loadFromDeudores <inputPath> [startRow] [count]")
  }

  const startRow = Number(process.argv[3] ?? 1)
  const count    = Number(process.argv[4] ?? 1_000_000)

  if (isNaN(startRow) || startRow < 1) throw new Error("startRow must be a positive number")
  if (isNaN(count)    || count    < 1) throw new Error("count must be a positive number")

  logger.info(`Input: ${inputPath}`)

  const repository = new Neo4jRepository()
  const loader = new DeudoresLoader(inputPath)
  const service = new LoaderService(repository, null)

  try {
    await service.run(loader, startRow, count)
  } finally {
    await Neo4jDriver.close()
  }

  logger.info("Done!")
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})