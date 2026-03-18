import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { parse } from "csv-parse/sync"
import neo4j from "neo4j-driver"
import { config } from "../config.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const driver = neo4j.driver(
  config.neo4j.uri,
  neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
)

const CUIT_REGEX = /^\d{2}-\d{8}-\d{1}$/

/**
 * Loads valid CUITs from a CSV file into Neo4j
 */
async function loadCuits() {
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

  const validRecords = records.filter((row) => CUIT_REGEX.test(row["CUIT"] ?? ""))

  console.log(`Total rows: ${records.length}`)
  console.log(`Valid CUITs: ${validRecords.length}`)
  console.log(`Skipped: ${records.length - validRecords.length}`)

  const session = driver.session()

  try {
    for (const row of validRecords) {
      await session.run(
        `
        MERGE (c:CUIT {id: $id})
        SET c.name = $name,
            c.email = $email,
            c.phone = $phone,
            c.inMyBase = true,
            c.source = $source
        `,
        {
          id: row["CUIT"],
          name: row["Nombre completo"],
          email: row["E-mail"],
          phone: row["Telefono"],
          source: "csv-poseidon",
        }
      )
    }
    console.log("Done!")
  } finally {
    await session.close()
    await driver.close()
  }
}

loadCuits().catch(console.error)