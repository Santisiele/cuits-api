import "dotenv/config"
import neo4j from "neo4j-driver"
import { logger } from "@logger.js"
import { config } from "@config.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { LEGACY_CRM_SOURCE_NAME } from "@domain/crm.js"
import { isProductionUri } from "@domain/crmImport.js"

const BATCH_SIZE = 1_000

const COUNT = `
  OPTIONAL MATCH (s:Source {name: $sourceName})
  RETURN s IS NOT NULL AS exists,
         COUNT { MATCH (:CUIT)-[:HAS_SOURCE]->(s) } AS attached,
         COUNT { MATCH (c:CUIT)-[:HAS_SOURCE]->(s) WHERE NOT EXISTS { MATCH (c)-[:HAS_SOURCE]->(o:Source) WHERE o <> s } } AS onlyThisSource
`

const DETACH_BATCH = `
  MATCH (c:CUIT)-[r:HAS_SOURCE]->(:Source {name: $sourceName})
  WITH c, r LIMIT $batchSize
  DELETE r
  WITH c
  SET c.sources = [x IN coalesce(c.sources, []) WHERE x <> $sourceName]
  WITH c
  OPTIONAL MATCH (c)-[:HAS_SOURCE]->(remaining:Source)
  WITH c, collect(remaining.category) AS categories
  SET c.isKnown  = "known"  IN categories,
      c.isToKnow = "toKnow" IN categories,
      c.inMyBase = size(categories) > 0
  RETURN count(c) AS detached
`

const DELETE_SOURCE = `
  MATCH (s:Source {name: $sourceName})
  WHERE NOT EXISTS { MATCH (:CUIT)-[:HAS_SOURCE]->(s) }
  DETACH DELETE s
`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes("--apply")
  const uri = config.neo4j.uri
  logger.info(`Target database: ${uri}`)
  if (apply && isProductionUri(uri) && !args.includes("--production")) {
    throw new Error("That is the production Aura. Point NEO4J_URI at staging, or add --production if you really mean it.")
  }

  const session = Neo4jDriver.instance.session()
  try {
    const record = (await session.run(COUNT, { sourceName: LEGACY_CRM_SOURCE_NAME })).records[0]!
    if (record.get("exists") !== true) {
      logger.info(`There is no "${LEGACY_CRM_SOURCE_NAME}" source. Nothing to do.`)
      return
    }
    const attached = Number(record.get("attached"))
    logger.info(`"${LEGACY_CRM_SOURCE_NAME}" holds ${attached} CUITs, ${Number(record.get("onlyThisSource"))} of them in no other source`)
    logger.info("They keep their CRM data and history; the ones in no other source stop counting as known")

    if (!apply) {
      logger.warn("Dry run: nothing was written. Add --apply to migrate.")
      return
    }

    let detached = 0
    for (;;) {
      const batch = Number(
        (await session.run(DETACH_BATCH, { sourceName: LEGACY_CRM_SOURCE_NAME, batchSize: neo4j.int(BATCH_SIZE) })).records[0]?.get("detached") ?? 0
      )
      detached += batch
      if (batch === 0) break
    }
    await session.run(DELETE_SOURCE, { sourceName: LEGACY_CRM_SOURCE_NAME })
    logger.info(`Detached ${detached} CUITs and deleted the "${LEGACY_CRM_SOURCE_NAME}" source`)
  } finally {
    await session.close()
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
