import "dotenv/config"
import fs from "fs"
import { logger } from "@logger.js"
import { config } from "@config.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jRepository } from "@infrastructure/neo4j/Neo4jRepository.js"
import { unpackBackup } from "@helpers/backupArchive.js"
import { chunk, groupByLabels, groupByType, parseBackup, summarise } from "@domain/backup.js"

const BATCH_SIZE = 1_000

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const filePath = args.find((arg) => !arg.startsWith("--"))
  const write = args.includes("--yes")
  const force = args.includes("--force")

  if (!filePath) throw new Error("Usage: pnpm restore:backup <file> [--yes] [--force]")
  if (!config.backup.passphrase) throw new Error("BACKUP_PASSPHRASE is not set")

  const backup = parseBackup(unpackBackup(fs.readFileSync(filePath), config.backup.passphrase))
  const byLabels = groupByLabels(backup.nodes)
  const byType = groupByType(backup.relationships)

  logger.info(`Backup taken ${backup.exportedAt || "(no date)"} with ${summarise(backup)}`)
  for (const [labels, nodes] of byLabels) logger.info(`  ${labels}: ${nodes.length} nodes`)
  for (const [type, relationships] of byType) logger.info(`  ${type}: ${relationships.length} relationships`)

  const repository = new Neo4jRepository()
  try {
    const existing = await repository.countAllNodes()
    logger.info(`The target database holds ${existing} nodes`)

    if (!write) {
      logger.warn("Dry run: nothing was written. Add --yes to restore.")
      return
    }
    if (existing > 0 && !force) {
      throw new Error(`Refusing to restore into a database that already holds ${existing} nodes. Add --force if you mean it.`)
    }

    let nodesCreated = 0
    for (const [labelKey, nodes] of byLabels) {
      const labels = labelKey.split(":")
      for (const batch of chunk(nodes, BATCH_SIZE)) {
        nodesCreated += await repository.restoreNodeBatch(labels, batch)
        logger.info(`  ${labelKey}: ${nodesCreated} nodes restored`)
      }
    }

    let relationshipsCreated = 0
    for (const [type, relationships] of byType) {
      for (const batch of chunk(relationships, BATCH_SIZE)) {
        relationshipsCreated += await repository.restoreRelationshipBatch(type, batch)
        logger.info(`  ${type}: ${relationshipsCreated} relationships restored`)
      }
    }

    const cleared = await repository.clearBackupKeys()
    logger.info("─── Summary ─────────────────────────────────")
    logger.info(`Nodes restored:         ${nodesCreated}`)
    logger.info(`Relationships restored: ${relationshipsCreated}`)
    logger.info(`Temporary keys removed: ${cleared}`)
  } finally {
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
