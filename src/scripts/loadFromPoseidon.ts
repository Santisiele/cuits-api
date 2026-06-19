import "dotenv/config"
import path from "path"
import { fileURLToPath } from "url"
import { logger } from "@logger"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jRepository } from "@infrastructure/neo4j/Neo4jRepository.js"
import { NosisEnricher } from "@infrastructure/nosis/NosisEnricher.js"
import { PoseidonLoader } from "@infrastructure/loaders/PoseidonLoader.js"
import { LoaderService } from "@application/LoaderService.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Driving adapter (CLI) for the Poseidon source.
 *
 * This script is intentionally thin: it wires up the concrete
 * infrastructure adapters and delegates to {@link LoaderService}.
 *
 * Usage:
 *   pnpm tsx src/scripts/loadFromPoseidon.ts [filePath] [startRow] [count] [sourceName]
 *
 * Defaults:
 *   filePath   = ./sources/Filled-dbPoseidon.xlsx
 *   startRow   = 1
 *   count      = 10
 *   sourceName = "poseidon"
 */
async function main(): Promise<void> {
  const filePath   = process.argv[2] ?? path.join(__dirname, "../../sources/Filled-dbPoseidon.xlsx")
  const startRow   = Number(process.argv[3] ?? 1)
  const count      = Number(process.argv[4] ?? 10)
  const sourceName = process.argv[5] ?? "poseidon"

  if (isNaN(startRow) || startRow < 1) throw new Error("startRow must be a positive number")
  if (isNaN(count)    || count    < 1) throw new Error("count must be a positive number")

  logger.info(`Source: ${sourceName}`)
  logger.info(`Input:  ${filePath}`)

  const repository = new Neo4jRepository()
  const enricher = await NosisEnricher.create()
  const loader = new PoseidonLoader(filePath, sourceName)
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