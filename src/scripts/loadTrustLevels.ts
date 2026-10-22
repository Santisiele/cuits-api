import "dotenv/config"
import XLSX from "xlsx"
import neo4j from "neo4j-driver"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import { describeTrustLevelImport, parseTrustLevels, type LevelOption } from "@domain/trustLevelImport.js"

const args = process.argv.slice(2)
const apply = args.includes("--apply")
const filePath = args.find((arg) => !arg.startsWith("--"))

if (!filePath) {
  console.error("Usage: pnpm load:trustLevels <file> [--apply]")
  process.exit(1)
}

const workbook = XLSX.readFile(filePath)
const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""]
if (!sheet) throw new Error("The workbook has no sheets")
const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })

const read = Neo4jDriver.instance.session({ defaultAccessMode: neo4j.session.READ })
let parsed: ReturnType<typeof parseTrustLevels>
let existing: Set<string>
try {
  const levelRecords = await read.run(Queries.FIND_TRUST_LEVEL_OPTIONS)
  const levels: LevelOption[] = levelRecords.records.map((record) => ({
    value: Number(record.get("value")),
    label: String(record.get("label")),
  }))
  parsed = parseTrustLevels(rows, levels)
  const found = await read.run(Queries.FIND_EXISTING_CUITS, { ids: parsed.assignments.map((a) => a.taxId) })
  existing = new Set(found.records.map((record) => String(record.get("id"))))
} finally {
  await read.close()
}

const toAssign = parsed.assignments.filter((assignment) => existing.has(assignment.taxId))
const missing = parsed.assignments.filter((assignment) => !existing.has(assignment.taxId)).map((a) => a.taxId)

logger.info(`${apply ? "Assigning" : "Dry run:"} trust levels from ${filePath}`)
for (const line of describeTrustLevelImport({ ...parsed, assignments: toAssign }, missing)) console.log(line)

if (!apply) {
  console.log("Nothing written. Run again with --apply to assign.")
  await Neo4jDriver.close()
  process.exit(0)
}

const write = Neo4jDriver.instance.session()
try {
  const result = await write.executeWrite((tx) =>
    tx.run(Queries.ASSIGN_TRUST_LEVELS, {
      rows: toAssign.map((assignment) => ({ ...assignment, value: neo4j.int(assignment.value) })),
    })
  )
  console.log(`Updated ${String(result.records[0]?.get("updated") ?? 0)} CUITs`)
} finally {
  await write.close()
  await Neo4jDriver.close()
}
