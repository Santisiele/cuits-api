import "dotenv/config"
import fs from "fs"
import path from "path"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jRepository } from "@infrastructure/neo4j/Neo4jRepository.js"
import { SacScraper } from "@scrapers/nosisSac.js"
import { BirthdaySweepService, type SweepEvent } from "@application/BirthdaySweepService.js"
import {
  DAILY_LIMIT,
  budgetFor,
  currentDay,
  restoreState,
  skipList,
  type ScrapeState,
} from "@helpers/birthdaySweep.js"

const MIN_DELAY_MS = 30_000
const MAX_DELAY_MS = 90_000

const STATE_PATH = path.resolve(process.cwd(), "data/scrapeBirthdays.json")

function readState(): ScrapeState {
  const raw = fs.existsSync(STATE_PATH) ? fs.readFileSync(STATE_PATH, "utf8") : null
  return restoreState(raw, currentDay())
}

function writeState(state: ScrapeState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8")
}

function randomDelay(): Promise<void> {
  const ms = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS
  logger.info(`  Waiting ${(ms / 1000).toFixed(1)}s before the next consultation...`)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function logEvent(event: SweepEvent): void {
  if (event.kind === "aborted") {
    logger.error(`${event.failures} consecutive failures — the session is probably dead. Stopping.`)
    return
  }
  const label = `[${event.position}/${event.total}] ${event.candidate.taxId} ${event.candidate.businessName}`
  if (event.kind === "updated") logger.info(`${label} ✓ ${event.birthday}`)
  if (event.kind === "not_found") logger.warn(`${label} ✗ not found in SAC`)
  if (event.kind === "no_date") logger.warn(`${label} ✗ no birth date in the Verificación de Identidad block`)
  if (event.kind === "failed") logger.error(`${label} ✗ ${event.message}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const requested = Number(args.find((a) => /^\d+$/.test(a)) ?? DAILY_LIMIT)

  if (isNaN(requested) || requested < 1) {
    throw new Error("The row count must be a positive number")
  }

  const state = readState()
  const budget = budgetFor(requested, state)

  logger.info(`Day ${state.day}: ${state.consultedToday}/${DAILY_LIMIT} consultations already spent`)

  if (budget < 1) {
    logger.warn(`Daily limit of ${DAILY_LIMIT} reached. Come back tomorrow.`)
    return
  }

  const service = new BirthdaySweepService(new Neo4jRepository())

  try {
    const pending = await service.countPending()
    const candidates = await service.findCandidates(state, budget)

    logger.info(`${pending} known people still without a birthday, ${skipList(state).length} already tried and skipped`)
    logger.info(`Budget for this run: ${budget}`)

    if (candidates.length === 0) {
      logger.info("Nothing left to consult.")
      return
    }

    if (dryRun) {
      for (const [index, candidate] of candidates.entries()) {
        logger.info(`[${index + 1}/${candidates.length}] p${candidate.priority} ${candidate.taxId} ${candidate.businessName}`)
      }
      logger.info(`Dry run: ${candidates.length} would be consulted, nothing was sent to Nosis`)
      return
    }

    logger.info("Logging into Nosis...")
    const scraper = await SacScraper.create()

    process.on("SIGINT", () => {
      writeState(state)
      logger.warn(`Interrupted. ${state.consultedToday}/${DAILY_LIMIT} consultations spent today.`)
      process.exit(0)
    })

    const tally = await service.sweep(scraper, candidates, state, {
      persist: writeState,
      wait: randomDelay,
      report: logEvent,
    })
    writeState(state)

    logger.info("─── Summary ─────────────────────────────────")
    logger.info(`Updated:          ${tally.updated}`)
    logger.info(`Without date:     ${tally.missing}`)
    logger.info(`Not found in SAC: ${tally.unresolved}`)
    logger.info(`Searches:         ${tally.searches}`)
    logger.info(`Consultations:    ${state.consultedToday}/${DAILY_LIMIT} today`)
    logger.info(`Still pending:    ${pending - tally.updated}`)
  } finally {
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
