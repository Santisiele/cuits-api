import "dotenv/config"
import { logger } from "@logger"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import { logSourceCreated } from "@auth/activityLogger.js"

/**
 * One-shot migration: promotes the denormalised `c.sources` string array
 * into first-class `(:Source)` nodes linked by `[:HAS_SOURCE]`.
 *
 * The array is NOT removed — it stays as a read cache. After this script
 * runs, every CUIT has both representations and `MERGE_BASE_NODE` keeps
 * them in sync from then on.
 *
 * Safety properties:
 *   - Fully idempotent: constraint uses IF NOT EXISTS, nodes and
 *     relationships use MERGE, and `migratedAt` is only written ON CREATE.
 *   - Fails before writing anything if it finds a source name that isn't
 *     in MIGRATION_CATEGORIES. There is no bypass flag: an unmapped source
 *     means the map is stale and must be reviewed by a human.
 *   - Chunked into independent transactions, so a failure mid-run leaves
 *     the already-committed batches intact and re-running skips them.
 *
 * Usage (LOCAL ONLY, with Aura env vars — never from Render / prod):
 *   pnpm migrate:sources
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Category of every source known to exist in production at migration time.
 * Hardcoded on purpose: this is a one-shot script and the mapping is a
 * human decision, not something derivable from the data.
 */
const MIGRATION_CATEGORIES: Record<string, "known" | "toKnow"> = {
  "Empresas concursadas":     "toKnow",
  "Bolsa":                    "toKnow",
  "Deudores por financiera":  "toKnow",
  "Clientes CRM":             "known",
  "Proveedores Nordelta":     "known",
  "conocidos-luchi":          "known",
  "Macabeadas 2026":          "known",
  "Empresas Credivico":       "known",
  "Residentes Senior Home":   "known",
  "Responsables Senior Home": "known",
  "xlsx-poseidon":            "known",
}

/**
 * Aura enforces per-transaction memory and timeout limits. With ~46k CUITs
 * and hundreds of thousands of relationships a single transaction fails,
 * so relationships are created in independent chunks.
 */
const BATCH_SIZE = 1000

/** There is no logged-in user during a migration; the log still needs an actor. */
const MIGRATION_USERNAME = "migration_script"

// ─── Queries ──────────────────────────────────────────────────────────────────

const DISCOVER_SOURCES = `
  MATCH (c:CUIT)
  WHERE c.sources IS NOT NULL AND size(c.sources) > 0
  UNWIND c.sources AS src
  RETURN DISTINCT src AS src
  ORDER BY src
`

const FIND_CUITS_WITH_SOURCES = `
  MATCH (c:CUIT)
  WHERE c.sources IS NOT NULL AND size(c.sources) > 0
  RETURN c.id AS id
  ORDER BY c.id
`

/**
 * `migratedAt` is written ON CREATE only, so re-running never re-stamps a
 * node and the timestamp keeps identifying exactly one migration run.
 */
const MERGE_SOURCE_NODE = `
  MERGE (s:Source {name: $name})
  ON CREATE SET s.category = $category, s.migratedAt = $migratedAt
`

const LINK_BATCH = `
  UNWIND $ids AS cuitId
  MATCH (c:CUIT {id: cuitId})
  UNWIND c.sources AS src
  MATCH (s:Source {name: src})
  MERGE (c)-[:HAS_SOURCE]->(s)
`

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Splits a list into fixed-size chunks, preserving order. */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const migrationTimestamp = new Date().toISOString()

  logger.info("─── Source migration ────────────────────────")
  logger.info(`Starting migration at ${migrationTimestamp}`)
  logger.info(
    `Use this timestamp to rollback: MATCH (s:Source {migratedAt: "${migrationTimestamp}"}) DETACH DELETE s`
  )

  const session = Neo4jDriver.instance.session()

  try {
    // ── 1. Constraint ────────────────────────────────────────────────────────
    await session.run(Queries.CREATE_SOURCE_CONSTRAINT)
    logger.info("Constraint source_name_unique ensured")

    // ── 2. Discover ──────────────────────────────────────────────────────────
    const discovered = (await session.run(DISCOVER_SOURCES)).records.map((record) =>
      String(record.get("src"))
    )
    logger.info(`Discovered ${discovered.length} distinct source names`)

    // ── 3. Validate ──────────────────────────────────────────────────────────
    const unknown = discovered.filter((name) => !(name in MIGRATION_CATEGORIES))
    if (unknown.length > 0) {
      logger.error(
        `Unknown sources found (${unknown.length}) — nothing was written. ` +
        `Add them to MIGRATION_CATEGORIES and re-run:`
      )
      for (const name of unknown) logger.error(`  - "${name}"`)
      await session.close()
      await Neo4jDriver.close()
      process.exit(1)
    }

    // ── 4. Source nodes ──────────────────────────────────────────────────────
    let sourcesCreated = 0
    for (const name of discovered) {
      const category = MIGRATION_CATEGORIES[name]!
      const result = await session.run(MERGE_SOURCE_NODE, {
        name,
        category,
        migratedAt: migrationTimestamp,
      })

      if (result.summary.counters.updates().nodesCreated > 0) {
        sourcesCreated++
        logSourceCreated(MIGRATION_USERNAME, name, category)
        logger.info(`source created: "${name}" (${category})`)
      } else {
        logger.info(`source already exists: "${name}" — left untouched`)
      }
    }

    // ── 5. Relationships ─────────────────────────────────────────────────────
    const cuitIds = (await session.run(FIND_CUITS_WITH_SOURCES)).records.map((record) =>
      String(record.get("id"))
    )
    const batches = chunk(cuitIds, BATCH_SIZE)
    logger.info(`Linking ${cuitIds.length} CUITs in ${batches.length} batches of ${BATCH_SIZE}`)

    let processedCuits = 0
    let relationshipsCreated = 0

    for (let i = 0; i < batches.length; i++) {
      const ids = batches[i]!
      const result = await session.executeWrite((tx) => tx.run(LINK_BATCH, { ids }))
      const created = result.summary.counters.updates().relationshipsCreated

      processedCuits += ids.length
      relationshipsCreated += created

      logger.info(
        `[batch ${i + 1}/${batches.length}] processed ${ids.length} CUITs, created ${created} relationships`
      )
    }

    // ── 6. Summary ───────────────────────────────────────────────────────────
    logger.info("─── Summary ─────────────────────────────────")
    logger.info(`Migration timestamp:    ${migrationTimestamp}`)
    logger.info(`Distinct sources:       ${discovered.length}`)
    logger.info(`Source nodes created:   ${sourcesCreated}`)
    logger.info(`Source nodes existing:  ${discovered.length - sourcesCreated}`)
    logger.info(`CUITs processed:        ${processedCuits}`)
    logger.info(`Relationships created:  ${relationshipsCreated}`)

    if (sourcesCreated === 0 && relationshipsCreated === 0) {
      logger.info("Nothing to do — the graph was already fully migrated")
    }
  } finally {
    await session.close()
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
