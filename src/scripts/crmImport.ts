import "dotenv/config"
import XLSX from "xlsx"
import { logger } from "@logger.js"
import { config } from "@config.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { CrmError, CrmService } from "@application/CrmService.js"
import { isProductionUri, parseCompanyList } from "@domain/crmImport.js"

const SHEET = "Listas"
const USAGE = "Usage: pnpm crm:import <file.xlsx> --by <username> [--apply] [--production]"

function argAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] && !args[index + 1]!.startsWith("--") ? args[index + 1]! : null
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const file = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--by")
  const by = argAfter(args, "--by")
  const apply = args.includes("--apply")
  if (!file || !by) throw new Error(USAGE)

  const uri = config.neo4j.uri
  logger.info(`Target database: ${uri}`)
  if (apply && isProductionUri(uri) && !args.includes("--production")) {
    throw new Error("That is the production Aura. Point NEO4J_URI at staging, or add --production if you really mean it.")
  }

  const workbook = XLSX.readFile(file)
  const sheet = workbook.Sheets[SHEET]
  if (!sheet) throw new Error(`The file has no "${SHEET}" sheet`)
  const parsed = parseCompanyList(XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" }))

  logger.info(`${parsed.companies.length} companies with a CUIT, ${parsed.withoutCuit.length} without, ${parsed.invalidCuit.length} with a malformed CUIT, ${parsed.conflicting.length} conflicting`)
  for (const name of parsed.withoutCuit) logger.warn(`  no CUIT: ${name}`)
  for (const item of parsed.invalidCuit) logger.warn(`  malformed CUIT: ${item.businessName} ${item.cuit}`)
  for (const item of parsed.conflicting) logger.warn(`  conflicting: ${item.businessName} ${item.cuits.join(", ")}`)

  const repository = new Neo4jCrmRepository()
  const service = new CrmService(repository)
  const tally = { added: 0, restored: 0, alreadyIn: 0, nosisPending: 0, failed: 0 }

  try {
    if (apply) await repository.ensureSetup()
    for (const [index, company] of parsed.companies.entries()) {
      const label = `[${index + 1}/${parsed.companies.length}] ${company.taxId} ${company.businessName}`
      if (!apply) {
        const state = await repository.findCuitState(company.taxId)
        if (state.inCrm) tally.alreadyIn++
        logger.info(`${label} ${state.inCrm ? "already in the CRM" : state.exists ? "in the graph, would join the CRM" : "new, would be created"}`)
        continue
      }
      try {
        const result = await service.addCompany(company, by)
        if (result.restored) tally.restored++
        else tally.added++
        if (result.nosisPending) tally.nosisPending++
        logger.info(`${label} ✓ ${result.created ? "created" : "joined"}${result.nosisPending ? ", pending in Nosis" : ""}`)
      } catch (err) {
        if (err instanceof CrmError && err.reason === "already_in_crm") {
          tally.alreadyIn++
          logger.info(`${label} already in the CRM`)
          continue
        }
        tally.failed++
        logger.error(`${label} ✗ ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    logger.info("─── Summary ─────────────────────────────────")
    if (!apply) {
      logger.info(`Already in the CRM: ${tally.alreadyIn}`)
      logger.warn("Dry run: nothing was written. Add --apply to load.")
      return
    }
    logger.info(`Added:              ${tally.added}`)
    logger.info(`Restored:           ${tally.restored}`)
    logger.info(`Already in the CRM: ${tally.alreadyIn}`)
    logger.info(`Pending in Nosis:   ${tally.nosisPending}`)
    logger.info(`Failed:             ${tally.failed}`)
  } finally {
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
