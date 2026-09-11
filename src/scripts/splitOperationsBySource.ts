import "dotenv/config"
import neo4j from "neo4j-driver"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"

const BATCH_SIZE = 200

interface SplitCounts {
  scanned: number
  bolsaOnly: number
  financieraOnly: number
  split: number
  unclassified: number
}

function classify(operation: Record<string, unknown>): "bolsa" | "financiera" | null {
  if ("alycSeller" in operation || "responsibleTaxId" in operation) return "bolsa"
  if ("entityName" in operation || "totalLoan" in operation) return "financiera"
  return null
}

function parse(raw: unknown): Record<string, unknown>[] {
  if (typeof raw !== "string" || raw.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
  } catch {
    return []
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run")
  logger.info(dryRun ? "Dry run: nothing will be written" : "Writing changes")

  const session = Neo4jDriver.instance.session()
  const counts: SplitCounts = {
    scanned: 0,
    bolsaOnly: 0,
    financieraOnly: 0,
    split: 0,
    unclassified: 0,
  }

  try {
    for (;;) {
      const result = await session.run(
        `MATCH (c:CUIT) WHERE c.operations IS NOT NULL
         RETURN c.id AS id, c.operations AS operations LIMIT $batchSize`,
        { batchSize: neo4j.int(BATCH_SIZE) }
      )
      if (result.records.length === 0) break

      for (const record of result.records) {
        const id = String(record.get("id"))
        const operations = parse(record.get("operations"))
        const bolsa = operations.filter((o) => classify(o) === "bolsa")
        const financiera = operations.filter((o) => classify(o) === "financiera")
        const unknown = operations.length - bolsa.length - financiera.length

        counts.scanned += 1
        if (unknown > 0) counts.unclassified += 1
        if (bolsa.length > 0 && financiera.length > 0) counts.split += 1
        else if (bolsa.length > 0) counts.bolsaOnly += 1
        else if (financiera.length > 0) counts.financieraOnly += 1

        if (dryRun) continue

        await session.run(
          `MATCH (c:CUIT {id: $id})
           SET c.bolsaOperations = CASE WHEN $bolsa = "" THEN c.bolsaOperations ELSE $bolsa END,
               c.financieraOperations = CASE WHEN $financiera = "" THEN c.financieraOperations ELSE $financiera END
           REMOVE c.operations`,
          {
            id,
            bolsa: bolsa.length > 0 ? JSON.stringify(bolsa) : "",
            financiera: financiera.length > 0 ? JSON.stringify(financiera) : "",
          }
        )
      }

      logger.info(`Processed ${counts.scanned} nodes so far`)
      if (dryRun) break
    }

    logger.info(
      `Done. scanned=${counts.scanned} bolsaOnly=${counts.bolsaOnly} ` +
        `financieraOnly=${counts.financieraOnly} split=${counts.split} ` +
        `unclassified=${counts.unclassified}`
    )
  } finally {
    await session.close()
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
