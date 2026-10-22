import "dotenv/config"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jRepository } from "@infrastructure/neo4j/Neo4jRepository.js"
import { DeudoresEntityLoader } from "@infrastructure/loaders/DeudoresEntityLoader.js"
import { LoaderService } from "@application/LoaderService.js"
import { describeDeudoresDryRun } from "@domain/deudores.js"

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const inputPath = args.find((arg) => arg !== "--dry-run")
  if (!inputPath) throw new Error("Usage: load:deudoresBancos <file> [--dry-run]")

  logger.info(`Input: ${inputPath}`)
  const loader = new DeudoresEntityLoader(inputPath)

  if (dryRun) {
    logger.info("Dry run: nothing will be written")
    for (const line of describeDeudoresDryRun(loader.read())) console.log(line)
    return
  }

  const service = new LoaderService(new Neo4jRepository(), null)
  try {
    await service.run(loader, 1, Number.MAX_SAFE_INTEGER)
  } finally {
    await Neo4jDriver.close()
  }

  logger.info("Done!")
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
