import "dotenv/config"
import neo4j, { type ManagedTransaction } from "neo4j-driver"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import {
  FINANCIERA_SOURCE,
  planBankOperations,
  emptyBankMigrationTally,
  tallyBankMigration,
  describeBankMigration,
  type BankOperationsPlan,
} from "@domain/bankOperations.js"

const BATCH_SIZE = 500

const FIND_BANK_DEBTORS = `
  MATCH (s:Source) WHERE s.name STARTS WITH "Deudores " AND s.name <> $financieraSource
  MATCH (c:CUIT)-[:HAS_SOURCE]->(s)
  WHERE c.id > $after
  WITH c, collect(s.name) AS sources
  ORDER BY c.id
  LIMIT $batchSize
  RETURN c.id AS taxId, sources, c.financieraOperations AS financiera, c.bankOperations AS bank
`

const MOVE_BANK_OPERATIONS = `
  UNWIND $updates AS update
  MATCH (c:CUIT {id: update.taxId})
  SET c.financieraOperations = update.financiera,
      c.bankOperations = update.bank
`

interface PlannedCuit {
  taxId: string
  plan: BankOperationsPlan | null
}

interface BankBatch {
  last: string
  planned: PlannedCuit[]
}

interface BankUpdate {
  taxId: string
  financiera: string | null
  bank: string
}

async function migrateBatch(
  tx: ManagedTransaction,
  after: string,
  apply: boolean
): Promise<BankBatch | null> {
  const result = await tx.run(FIND_BANK_DEBTORS, {
    financieraSource: FINANCIERA_SOURCE,
    after,
    batchSize: neo4j.int(BATCH_SIZE),
  })
  if (result.records.length === 0) return null

  const planned = result.records.map((record) => ({
    taxId: String(record.get("taxId")),
    plan: planBankOperations(record.get("sources") as string[], record.get("financiera"), record.get("bank")),
  }))

  const updates: BankUpdate[] = []
  for (const { taxId, plan } of planned) {
    if (!plan) continue
    updates.push({
      taxId,
      financiera: plan.financiera.length > 0 ? JSON.stringify(plan.financiera) : null,
      bank: JSON.stringify(plan.bank),
    })
  }

  if (apply && updates.length > 0) await tx.run(MOVE_BANK_OPERATIONS, { updates })
  return { last: planned[planned.length - 1]!.taxId, planned }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  logger.info(apply ? "Applying: operations will be moved" : "Dry run: nothing will be written")

  const session = Neo4jDriver.instance.session({
    defaultAccessMode: apply ? neo4j.session.WRITE : neo4j.session.READ,
  })
  const tally = emptyBankMigrationTally()

  try {
    let after = ""
    for (;;) {
      const cursor = after
      const batch = apply
        ? await session.executeWrite((tx) => migrateBatch(tx, cursor, true))
        : await session.executeRead((tx) => migrateBatch(tx, cursor, false))
      if (!batch) break
      for (const { taxId, plan } of batch.planned) tallyBankMigration(tally, taxId, plan)
      after = batch.last
      logger.info(`Examined ${tally.examined} CUITs so far`)
    }
  } finally {
    await session.close()
    await Neo4jDriver.close()
  }

  for (const line of describeBankMigration(tally, apply)) console.log(line)
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
