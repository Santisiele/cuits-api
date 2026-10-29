import "dotenv/config"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jRepository } from "@infrastructure/neo4j/Neo4jRepository.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { NosisEnricher } from "@infrastructure/nosis/NosisEnricher.js"
import { NosisPendingService } from "@application/NosisPendingService.js"
import type { NosisRunEvent } from "@domain/nosisPending.js"

const MIN_DELAY_MS = 30_000
const MAX_DELAY_MS = 90_000

function randomDelay(): Promise<void> {
  const ms = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS
  logger.info(`  Waiting ${(ms / 1000).toFixed(1)}s before the next search...`)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function logEvent(event: NosisRunEvent): void {
  if (event.kind === "aborted") {
    logger.error(`${event.failures} consecutive failures — the session is probably dead. Stopping.`)
    return
  }
  const label = `[${event.position}/${event.total}] ${event.item.taxId} ${event.item.businessName}`
  if (event.kind === "searched") logger.info(`${label} ✓ ${event.related} related, ${event.relationships} relationships`)
  if (event.kind === "not_found") logger.warn(`${label} ✗ not found in Nosis, still pending`)
  if (event.kind === "failed") logger.error(`${label} ✗ ${event.message}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const countArg = args.find((arg) => /^\d+$/.test(arg))
  const count = countArg === undefined ? null : Number(countArg)
  if (count !== null && count < 1) throw new Error("The count must be a positive number")

  const service = new NosisPendingService(new Neo4jCrmRepository())
  try {
    const pending = await service.list()
    const queue = count === null ? pending : pending.slice(0, count)
    logger.info(`${pending.length} CUITs pending in Nosis, ${queue.length} in this run`)

    if (queue.length === 0) {
      logger.info("Nothing to search.")
      return
    }

    if (dryRun) {
      for (const [index, item] of queue.entries()) {
        logger.info(`[${index + 1}/${queue.length}] ${item.taxId} ${item.businessName} — added by ${item.addedBy ?? "?"} on ${item.addedAt ?? "?"}`)
      }
      logger.info("Dry run: nothing was sent to Nosis")
      return
    }

    logger.info("Logging into Nosis...")
    const enricher = await NosisEnricher.create()
    const tally = await service.run(enricher, new Neo4jRepository(), queue, { wait: randomDelay, report: logEvent })

    logger.info("─── Summary ─────────────────────────────────")
    logger.info(`Searched:          ${tally.searched}`)
    logger.info(`Not found:         ${tally.notFound}`)
    logger.info(`Failed:            ${tally.failed}`)
    logger.info(`Still pending:     ${pending.length - tally.searched}`)
  } finally {
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
