import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { parse } from "csv-parse/sync"
import neo4j from "neo4j-driver"
import { config } from "@config.js"
import { filterValidCuits, loadCuitsIntoNeo4j } from "@helpers/cuitLoader.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const driver = neo4j.driver(
  config.neo4j.uri,
  neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
)

/**
 * Main script to load CUITs from CSV into Neo4j
 */
async function main() {
  const content = fs.readFileSync(
    path.join(__dirname, "../../../sources/Poseidon.csv"),
    { encoding: "latin1" }
  )

  const records = parse(content, {
    delimiter: ";",
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[]

  const validCuits = filterValidCuits(records, "csv-poseidon")

  console.log(`Total rows: ${records.length}`)
  console.log(`Valid CUITs: ${validCuits.length}`)
  console.log(`Skipped: ${records.length - validCuits.length}`)

  const session = driver.session()

  try {
    await loadCuitsIntoNeo4j(validCuits, session)
    console.log("Done!")
  } finally {
    await session.close()
    await driver.close()
  }
}

main().catch(console.error)