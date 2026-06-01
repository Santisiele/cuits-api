import "dotenv/config"
import { logger } from "@logger"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jRepository } from "@infrastructure/neo4j/Neo4jRepository.js"
import { NosisEnricher } from "@infrastructure/nosis/NosisEnricher.js"
import { SeniorHomeLoader } from "@infrastructure/loaders/SeniorHomeLoader.js"
import { SeniorHomeXlsxWriter } from "@infrastructure/output/SeniorHomeXlsxWriter"
import { LoaderService } from "@application/LoaderService.js"

/**
 * Driving adapter (CLI) for the Senior Home source.
 *
 * Wires the SeniorHomeLoader, NosisEnricher, Neo4jRepository and
 * SeniorHomeXlsxWriter together and delegates orchestration to the
 * LoaderService.
 *
 * Usage:
 *   pnpm tsx src/scripts/loadFromSeniorHome.ts <inputPath> <outputPath> [startRow] [count]
 *
 * Example:
 *   pnpm tsx src/scripts/loadFromSeniorHome.ts ./sources/seniorHome.csv ./output/seniorHome-log.xlsx 1 50
 */
async function main(): Promise<void> {
  const inputPath  = process.argv[2]
  const outputPath = process.argv[3]
  if (!inputPath || !outputPath) {
    throw new Error("Usage: loadFromSeniorHome <inputPath> <outputPath> [startRow] [count]")
  }

  const startRow = Number(process.argv[4] ?? 1)
  const count    = Number(process.argv[5] ?? 1_000_000)

  if (isNaN(startRow) || startRow < 1) throw new Error("startRow must be a positive number")
  if (isNaN(count)    || count    < 1) throw new Error("count must be a positive number")

  logger.info(`Input:  ${inputPath}`)
  logger.info(`Output: ${outputPath}`)

  const repository = new Neo4jRepository()
  const enricher = await NosisEnricher.create()
  const loader = new SeniorHomeLoader(inputPath)
  const writer = new SeniorHomeXlsxWriter(outputPath)
  const service = new LoaderService(repository, enricher, writer)

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