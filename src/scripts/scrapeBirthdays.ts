import "dotenv/config"
import fs from "fs"
import neo4j from "neo4j-driver"
import path from "path"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { SacScraper } from "@scrapers/nosisSac.js"
import {
  DAILY_LIMIT,
  budgetFor,
  currentDay,
  markConsultation,
  markMiss,
  restoreState,
  skipList,
  type ScrapeState,
} from "@helpers/birthdaySweep.js"

const MIN_DELAY_MS = 30_000
const MAX_DELAY_MS = 90_000
const MAX_CONSECUTIVE_FAILURES = 3

const STATE_PATH = path.resolve(process.cwd(), "data/scrapeBirthdays.json")

const CANDIDATES_QUERY = `
  MATCH (c:CUIT {isKnown: true})
  WHERE c.id =~ '^(20|23|24|27)[0-9]{9}$'
    AND (c.birthday IS NULL OR trim(c.birthday) = '')
    AND NOT c.id IN $skip
  OPTIONAL MATCH (c)-[:HAS_SOURCE]->(s:Source)
  WITH c, collect(s.name) AS sources
  WITH c, sources,
       CASE
         WHEN 'Residentes Senior Home' IN sources THEN 0
         WHEN 'Responsables Senior Home' IN sources THEN 1
         ELSE 2
       END AS priority
  RETURN c.id AS taxId, c.businessName AS businessName, priority
  ORDER BY priority, taxId
  LIMIT $limit
`

const REMAINING_QUERY = `
  MATCH (c:CUIT {isKnown: true})
  WHERE c.id =~ '^(20|23|24|27)[0-9]{9}$'
    AND (c.birthday IS NULL OR trim(c.birthday) = '')
  RETURN count(c) AS pending
`

const UPDATE_QUERY = `
  MATCH (c:CUIT {id: $taxId})
  SET c.birthday = $birthday
  RETURN c.id AS taxId
`

interface Candidate {
  taxId: string
  businessName: string
  priority: number
}

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

  const session = Neo4jDriver.instance.session()
  let candidates: Candidate[] = []
  let pending = 0

  try {
    const pendingResult = await session.run(REMAINING_QUERY)
    pending = Number(pendingResult.records[0]?.get("pending") ?? 0)

    const result = await session.run(CANDIDATES_QUERY, {
      skip: skipList(state),
      limit: neo4j.int(budget),
    })
    candidates = result.records.map((record) => ({
      taxId: String(record.get("taxId")),
      businessName: String(record.get("businessName") ?? ""),
      priority: Number(record.get("priority")),
    }))
  } catch (error) {
    await session.close()
    await Neo4jDriver.close()
    throw error
  }

  logger.info(`${pending} known people still without a birthday, ${skipList(state).length} already tried and skipped`)
  logger.info(`Budget for this run: ${budget}`)

  if (candidates.length === 0) {
    logger.info("Nothing left to consult.")
    await session.close()
    await Neo4jDriver.close()
    return
  }

  if (dryRun) {
    for (const [index, candidate] of candidates.entries()) {
      logger.info(`[${index + 1}/${candidates.length}] p${candidate.priority} ${candidate.taxId} ${candidate.businessName}`)
    }
    logger.info(`Dry run: ${candidates.length} would be consulted, nothing was sent to Nosis`)
    await session.close()
    await Neo4jDriver.close()
    return
  }

  logger.info("Logging into Nosis...")
  const scraper = await SacScraper.create()

  let updated = 0
  let missing = 0
  let unresolved = 0
  let searches = 0
  let consecutiveFailures = 0

  const persist = (): void => {
    writeState(state)
  }
  process.on("SIGINT", () => {
    persist()
    logger.warn(`Interrupted. ${state.consultedToday}/${DAILY_LIMIT} consultations spent today.`)
    process.exit(0)
  })

  try {
    for (const [index, candidate] of candidates.entries()) {
      const label = `[${index + 1}/${candidates.length}] ${candidate.taxId} ${candidate.businessName}`

      try {
        searches++
        const identity = await scraper.searchDocument(candidate.taxId)
        if (!identity) {
          unresolved++
          markMiss(state, candidate.taxId)
          persist()
          logger.warn(`${label} ✗ not found in SAC`)
          consecutiveFailures = 0
          await randomDelay()
          continue
        }

        const birthday = await scraper.fetchBirthday(identity.taxId, identity.businessName)
        markConsultation(state)
        persist()

        if (!birthday) {
          missing++
          markMiss(state, candidate.taxId)
          persist()
          logger.warn(`${label} ✗ no birth date in the Verificación de Identidad block`)
        } else {
          await session.run(UPDATE_QUERY, { taxId: candidate.taxId, birthday })
          updated++
          logger.info(`${label} ✓ ${birthday}`)
        }
        consecutiveFailures = 0
      } catch (error) {
        markConsultation(state)
        persist()
        consecutiveFailures++
        logger.error(`${label} ✗ ${error instanceof Error ? error.message : String(error)}`)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.error(`${MAX_CONSECUTIVE_FAILURES} consecutive failures — the session is probably dead. Stopping.`)
          break
        }
      }

      if (index < candidates.length - 1) await randomDelay()
    }
  } finally {
    persist()
    await session.close()
    await Neo4jDriver.close()
  }

  logger.info("─── Summary ─────────────────────────────────")
  logger.info(`Updated:          ${updated}`)
  logger.info(`Without date:     ${missing}`)
  logger.info(`Not found in SAC: ${unresolved}`)
  logger.info(`Searches:         ${searches}`)
  logger.info(`Consultations:    ${state.consultedToday}/${DAILY_LIMIT} today`)
  logger.info(`Still pending:    ${pending - updated}`)
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
