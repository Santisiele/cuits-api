import "dotenv/config"
import fs from "fs"
import { logger } from "@logger.js"
import { config } from "@config.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import { isProductionUri } from "@domain/crmImport.js"
import { cleanResponsibleName, isResponsibleColor, responsibleKey } from "@domain/responsibles.js"
import { usernameKey } from "@domain/users.js"

interface MappingEntry {
  name: string
  color: string
  users: string[]
  from: string[]
}

const USAGE = "Usage: pnpm migrate:responsibles <mapping.json> [--disable-users a,b,c] [--apply] [--production]"

const COUNT_FROM = `
  RETURN COUNT { MATCH (t:Task) WHERE toLower(t.assignee) IN $from } AS tasks,
         COUNT { MATCH (a:Action) WHERE toLower(a.doneBy) IN $from } AS actions
`

const UPSERT = `
  MERGE (r:Responsible {nameKey: $nameKey})
  ON CREATE SET r.createdAt = $at, r.createdBy = "migration", r.disabledAt = null
  SET r.name = $name, r.color = $color, r.users = $users
`

const REPOINT_TASKS = `
  MATCH (r:Responsible {nameKey: $nameKey})
  MATCH (t:Task) WHERE toLower(t.assignee) IN $from
  OPTIONAL MATCH (t)-[old:ASSIGNED_TO]->()
  DELETE old
  WITH DISTINCT r, t
  SET t.assignee = r.name
  MERGE (t)-[:ASSIGNED_TO]->(r)
  RETURN count(t) AS moved
`

const REPOINT_ACTIONS = `
  MATCH (r:Responsible {nameKey: $nameKey})
  MATCH (a:Action) WHERE toLower(a.doneBy) IN $from
  OPTIONAL MATCH (a)-[old:DONE_BY]->()
  DELETE old
  WITH DISTINCT r, a
  SET a.recordedBy = coalesce(a.recordedBy, a.doneBy), a.doneBy = r.name
  MERGE (a)-[:DONE_BY]->(r)
  RETURN count(a) AS moved
`

const DISABLE_USER = `
  MATCH (u:User {usernameKey: $key})
  WHERE u.role = "member"
  SET u.disabledAt = coalesce(u.disabledAt, $at)
  RETURN u.username AS username
`

function readMapping(file: string): MappingEntry[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!Array.isArray(parsed)) throw new Error("The mapping must be a list")
  return parsed.map((entry: Partial<MappingEntry>) => {
    const name = cleanResponsibleName(entry.name)
    if (!name) throw new Error(`Bad name: ${String(entry.name)}`)
    if (!isResponsibleColor(entry.color)) throw new Error(`Bad color for ${name}: ${String(entry.color)}`)
    return { name, color: entry.color, users: entry.users ?? [], from: (entry.from ?? []).map((value) => value.toLowerCase()) }
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const file = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--disable-users")
  if (!file) throw new Error(USAGE)
  const apply = args.includes("--apply")
  const disableIndex = args.indexOf("--disable-users")
  const toDisable = disableIndex >= 0 ? (args[disableIndex + 1] ?? "").split(/[\s,]+/).filter(Boolean) : []

  const uri = config.neo4j.uri
  logger.info(`Target database: ${uri}`)
  if (apply && isProductionUri(uri) && !args.includes("--production")) {
    throw new Error("That is the production Aura. Point NEO4J_URI at staging, or add --production if you really mean it.")
  }

  const mapping = readMapping(file)
  const session = Neo4jDriver.instance.session()
  const at = new Date().toISOString()
  try {
    for (const entry of mapping) {
      const record = (await session.run(COUNT_FROM, { from: entry.from })).records[0]!
      logger.info(
        `${entry.name} (${entry.color}, users: ${entry.users.join(", ") || "none"}) takes ${Number(record.get("tasks"))} tasks and ${Number(record.get("actions"))} actions from ${entry.from.join(", ") || "nobody"}`
      )
    }
    if (toDisable.length > 0) logger.info(`Users to disable (members only): ${toDisable.join(", ")}`)

    if (!apply) {
      logger.warn("Dry run: nothing was written. Add --apply to migrate.")
      return
    }

    await session.run(Queries.RESPONSIBLE_CONSTRAINT)
    for (const entry of mapping) {
      const params = { name: entry.name, nameKey: responsibleKey(entry.name), color: entry.color, users: entry.users, from: entry.from, at }
      await session.run(UPSERT, params)
      const tasks = Number((await session.run(REPOINT_TASKS, params)).records[0]?.get("moved") ?? 0)
      const actions = Number((await session.run(REPOINT_ACTIONS, params)).records[0]?.get("moved") ?? 0)
      logger.info(`  ${entry.name}: ${tasks} tasks, ${actions} actions`)
    }
    for (const username of toDisable) {
      const disabled = (await session.run(DISABLE_USER, { key: usernameKey(username), at })).records.length > 0
      logger.info(`  user ${username}: ${disabled ? "disabled" : "left alone (not a member or not found)"}`)
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
