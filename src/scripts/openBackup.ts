import "dotenv/config"
import fs from "fs"
import path from "path"
import { logger } from "@logger.js"
import { config } from "@config.js"
import { unpackBackup } from "@helpers/backupArchive.js"
import { groupByLabels, groupByType, parseBackup, summarise } from "@domain/backup.js"

function main(): void {
  const args = process.argv.slice(2)
  const input = args.find((arg) => !arg.startsWith("--"))
  if (!input) throw new Error("Usage: pnpm backup:open <file> [--json]")
  if (!config.backup.passphrase) throw new Error("BACKUP_PASSPHRASE is not set")

  const json = unpackBackup(fs.readFileSync(input), config.backup.passphrase)
  const backup = parseBackup(json)

  logger.info(`Backup taken ${backup.exportedAt || "(no date)"} with ${summarise(backup)}`)
  for (const [labels, nodes] of groupByLabels(backup.nodes)) logger.info(`  ${labels}: ${nodes.length} nodes`)
  for (const [type, relationships] of groupByType(backup.relationships)) {
    logger.info(`  ${type}: ${relationships.length} relationships`)
  }

  if (!args.includes("--json")) {
    logger.info("Add --json to write the readable copy next to the backup.")
    return
  }

  const output = path.join(path.dirname(input), `${path.basename(input).replace(/\.gz\.aes$/, "")}.json`)
  fs.writeFileSync(output, json, "utf8")
  logger.warn(`Written unencrypted to ${output} — delete it when you are done.`)
}

try {
  main()
} catch (err) {
  logger.error(err)
  process.exit(1)
}
