import "dotenv/config"
import XLSX from "xlsx"
import { config } from "@config.js"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { CrmCompanyService } from "@application/CrmCompanyService.js"
import { CrmWorkService } from "@application/CrmWorkService.js"
import { CrmError } from "@application/CrmServiceBase.js"
import { loadCompanyHistory } from "@application/crmHistoryLoader.js"
import { isProductionUri } from "@domain/crmImport.js"
import { parseAliases, parseHistory, responsiblesIn } from "@domain/crmHistoryImport.js"
import { foundCompanies } from "@domain/crmMissingCuits.js"
import { responsibleKey } from "@domain/responsibles.js"

const USAGE = 'Usage: pnpm crm:import-found "<Empresas sin CUIT.xlsx>" "<CRM Propio.xlsx>" --by <username> [--alias "luc=Luchi"]... [--apply] [--production]'

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]!] : []))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flagsWithValue = new Set(["--by", "--alias"])
  const [foundFile, crmFile] = args.filter((arg, index) => !arg.startsWith("--") && !flagsWithValue.has(args[index - 1] ?? ""))
  const by = valuesAfter(args, "--by")[0]
  if (!foundFile || !crmFile || !by) throw new Error(USAGE)
  const apply = args.includes("--apply")

  const uri = config.neo4j.uri
  logger.info(`Target database: ${uri}`)
  if (apply && isProductionUri(uri) && !args.includes("--production")) {
    throw new Error("That is the production Aura. Point NEO4J_URI at staging, or add --production if you really mean it.")
  }

  const foundSheet = XLSX.readFile(foundFile).Sheets["Sin CUIT"]
  const crm = XLSX.readFile(crmFile)
  if (!foundSheet || !crm.Sheets["Listas"] || !crm.Sheets["Seguimiento"]) throw new Error("Expected the Sin CUIT sheet and the Listas and Seguimiento sheets")
  const listas = XLSX.utils.sheet_to_json<Record<string, unknown>>(crm.Sheets["Listas"], { defval: "" })
  const found = foundCompanies(XLSX.utils.sheet_to_json<Record<string, unknown>>(foundSheet, { defval: "" }), listas)
  const history = parseHistory(
    XLSX.utils.sheet_to_json<Record<string, unknown>>(crm.Sheets["Seguimiento"], { defval: "" }),
    found.taxIdByCompany,
    parseAliases(valuesAfter(args, "--alias")),
    by,
    found.companyByContact
  )

  logger.info(`${found.companies.length} companies to load, ${found.skipped.length} left out`)
  for (const item of found.skipped) logger.warn(`  left out: ${item.name} (${item.reason})`)

  const repository = new Neo4jCrmRepository()
  const companies = new CrmCompanyService(repository)
  const work = new CrmWorkService(repository)
  const tally = { added: 0, alreadyIn: 0, failed: 0, actions: 0, actionsFailed: 0, historySkipped: 0 }

  try {
    const known = new Set((await repository.listResponsibles()).map((responsible) => responsibleKey(responsible.name)))
    const missing = [...responsiblesIn(history)].filter((name) => !known.has(responsibleKey(name)))
    if (missing.length > 0) throw new Error(`These responsibles do not exist yet: ${missing.join(", ")}`)

    for (const [index, company] of found.companies.entries()) {
      const steps = history.byCompany.get(company.taxId) ?? []
      const label = `[${index + 1}/${found.companies.length}] ${company.taxId} ${company.businessName} (${steps.length} actions)`
      const state = await repository.findCuitState(company.taxId)
      const existingActions = state.inCrm ? (await repository.listActions(company.taxId)).length : 0
      const historyNote = existingActions > 0 ? `, keeps its ${existingActions} actions and gets none of these` : ""

      if (!apply) {
        logger.info(`${label} ${state.inCrm ? "already in the CRM" : state.exists ? "in the graph, would join the CRM" : "new, would be created"}${historyNote}`)
        continue
      }

      try {
        await companies.addCompany(company, by)
        tally.added++
      } catch (err) {
        if (!(err instanceof CrmError && err.reason === "already_in_crm")) {
          tally.failed++
          logger.error(`${label} ✗ ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        tally.alreadyIn++
      }
      if (existingActions > 0) {
        tally.historySkipped += steps.length
        logger.warn(`${label} history left out${historyNote}`)
        continue
      }
      const loaded = await loadCompanyHistory(work, company.taxId, steps, by, (step, message) =>
        logger.error(`  ${step.businessName} ${step.date} ✗ ${message}`)
      )
      tally.actions += loaded.done
      tally.actionsFailed += loaded.failed
      logger.info(`${label} ✓`)
    }

    logger.info("─── Summary ─────────────────────────────────")
    if (!apply) {
      logger.warn("Dry run: nothing was written. Add --apply to load.")
      return
    }
    logger.info(`Companies added:     ${tally.added}`)
    logger.info(`Already in the CRM:  ${tally.alreadyIn}`)
    logger.info(`Companies failed:    ${tally.failed}`)
    logger.info(`Actions recorded:    ${tally.actions}`)
    logger.info(`Actions failed:      ${tally.actionsFailed}`)
    logger.info(`Actions left out:    ${tally.historySkipped}`)
  } finally {
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
