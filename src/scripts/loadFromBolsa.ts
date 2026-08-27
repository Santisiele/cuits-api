import "dotenv/config"
import { logger } from "@logger"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jRepository } from "@infrastructure/neo4j/Neo4jRepository.js"
import { BolsaLoader } from "@infrastructure/loaders/BolsaLoader.js"
import { LoaderService } from "@application/LoaderService.js"

/**
 * Driving adapter (CLI) for the "Bolsa" source.
 *
 * No enricher is passed to LoaderService → no Nosis calls, no throttling.
 * Rows are pre-aggregated by beneficiary CUIT inside the loader, so the
 * number of LoadableRows the service processes equals the number of
 * unique beneficiaries in the Excel file, not the row count.
 *
 * Usage:
 *   pnpm tsx src/scripts/loadFromBolsa.ts <inputPath> [startRow] [count]
 *
 * The startRow/count arguments still slice the Excel BEFORE grouping,
 * so they behave like they do in other loaders: they limit which raw
 * rows enter the pipeline.
 *
 * Example:
 *   pnpm tsx src/scripts/loadFromBolsa.ts ./sources/toKnow/bolsa.xlsx
 */
async function main(): Promise<void> {
  const inputPath = process.argv[2]
  if (!inputPath) {
    throw new Error("Usage: loadFromBolsa <inputPath> [startRow] [count]")
  }

  const startRow = Number(process.argv[3] ?? 1)
  const count    = Number(process.argv[4] ?? 1_000_000)

  if (isNaN(startRow) || startRow < 1) throw new Error("startRow must be a positive number")
  if (isNaN(count)    || count    < 1) throw new Error("count must be a positive number")

  logger.info(`Input: ${inputPath}`)

  const repository = new Neo4jRepository()
  const loader = new BolsaLoader(inputPath)
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