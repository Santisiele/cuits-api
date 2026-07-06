import "dotenv/config"
import { logger } from "@logger"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jRepository } from "@infrastructure/neo4j/Neo4jRepository.js"
import { ConcursadasLoader } from "@infrastructure/loaders/ConcursadasLoader.js"
import { LoaderService } from "@application/LoaderService.js"

/**
 * Driving adapter (CLI) for the "Empresas concursadas" source.
 *
 * No enricher is passed to LoaderService → no Nosis calls, no throttling.
 * Nodes go straight to Neo4j tagged as isToKnow=true. The whole load
 * finishes in seconds even for thousands of rows.
 *
 * Usage:
 *   pnpm tsx src/scripts/loadFromConcursadas.ts <inputPath> [startRow] [count]
 *
 * Example:
 *   pnpm tsx src/scripts/loadFromConcursadas.ts ./sources/concursadas.xlsx 1 10000
 */
async function main(): Promise<void> {
  const inputPath = process.argv[2]
  if (!inputPath) {
    throw new Error("Usage: loadFromConcursadas <inputPath> [startRow] [count]")
  }

  const startRow = Number(process.argv[3] ?? 1)
  const count    = Number(process.argv[4] ?? 1_000_000)

  if (isNaN(startRow) || startRow < 1) throw new Error("startRow must be a positive number")
  if (isNaN(count)    || count    < 1) throw new Error("count must be a positive number")

  logger.info(`Input: ${inputPath}`)

  const repository = new Neo4jRepository()
  const loader = new ConcursadasLoader(inputPath) 
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