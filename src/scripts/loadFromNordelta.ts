import "dotenv/config"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jRepository } from "@infrastructure/neo4j/Neo4jRepository.js"
import { NosisEnricher } from "@infrastructure/nosis/NosisEnricher.js"
import { NordeltaLoader } from "@infrastructure/loaders/NordeltaLoader.js"
import { LoaderService } from "@application/LoaderService.js"

/**
 * Driving adapter (CLI) for the "Proveedores Nordelta" source.
 *
 * Wires the NordeltaLoader, NosisEnricher, and Neo4jRepository together
 * and delegates orchestration to the LoaderService.
 *
 * Usage:
 *   pnpm tsx src/scripts/loadFromNordelta.ts <inputPath> [startRow] [count]
 *
 * Example:
 *   pnpm tsx src/scripts/loadFromNordelta.ts ./sources/proveedores-nordelta.xlsx 1 100
 */
async function main(): Promise<void> {
  const inputPath = process.argv[2]
  if (!inputPath) {
    throw new Error("Usage: loadFromNordelta <inputPath> [startRow] [count]")
  }

  const startRow = Number(process.argv[3] ?? 1)
  const count    = Number(process.argv[4] ?? 1_000_000)

  if (isNaN(startRow) || startRow < 1) throw new Error("startRow must be a positive number")
  if (isNaN(count)    || count    < 1) throw new Error("count must be a positive number")

  logger.info(`Input: ${inputPath}`)

  const repository = new Neo4jRepository()
  const enricher = await NosisEnricher.create()
  const loader = new NordeltaLoader(inputPath)
  const service = new LoaderService(repository, enricher)

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