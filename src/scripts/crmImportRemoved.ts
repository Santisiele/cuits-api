import "dotenv/config"
import XLSX from "xlsx"
import { config } from "@config.js"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { CrmCompanyService } from "@application/CrmCompanyService.js"
import { CrmContactService } from "@application/CrmContactService.js"
import { CrmWorkService } from "@application/CrmWorkService.js"
import { CrmError } from "@application/CrmServiceBase.js"
import { loadCompanyHistory } from "@application/crmHistoryLoader.js"
import { isProductionUri } from "@domain/crmImport.js"
import { NO_DETAIL, nameKey, parseAliases, parseHistory } from "@domain/crmHistoryImport.js"
import { contactInDescription, parseListasContacts, stepsNotLoaded } from "@domain/crmContactImport.js"
import { REMOVED_REASON, parseRemovedSheet } from "@domain/crmRemovedImport.js"

const USAGE = 'Usage: pnpm crm:import-removed "<CRM Propio.xlsx>" --by <username> [--cuit "NITO TEXTIL=30717893855"]... [--apply] [--production]'

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]!] : []))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flagsWithValue = new Set(["--by", "--cuit"])
  const file = args.find((arg, index) => !arg.startsWith("--") && !flagsWithValue.has(args[index - 1] ?? ""))
  const by = valuesAfter(args, "--by")[0]
  if (!file || !by) throw new Error(USAGE)
  const apply = args.includes("--apply")
  const cuits = new Map(valuesAfter(args, "--cuit").map((pair) => pair.split("=").map((part) => part.trim()) as [string, string]))

  const uri = config.neo4j.uri
  logger.info(`Target database: ${uri}`)
  if (apply && isProductionUri(uri) && !args.includes("--production")) {
    throw new Error("That is the production Aura. Point NEO4J_URI at staging, or add --production if you really mean it.")
  }

  const sheet = XLSX.readFile(file).Sheets["Eliminados"]
  if (!sheet) throw new Error('The file has no "Eliminados" sheet')
  const removed = parseRemovedSheet(XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" }), cuits)
  const history = parseHistory(removed.seguimiento, removed.taxIdByCompany, parseAliases([]), by)
  const people = parseListasContacts(removed.listas, removed.taxIdByCompany)
  logger.info(`${removed.companies.length} removed companies, ${removed.withoutCuit.length} without CUIT: ${removed.withoutCuit.join(", ") || "none"}`)

  const repository = new Neo4jCrmRepository()
  const companies = new CrmCompanyService(repository)
  const contacts = new CrmContactService(repository)
  const work = new CrmWorkService(repository)

  try {
    for (const company of removed.companies) {
      const steps = history.byCompany.get(company.taxId) ?? []
      const state = await repository.findCuitState(company.taxId)
      const existing = state.inCrm ? await repository.listActions(company.taxId) : []
      const pending = stepsNotLoaded(steps, existing)
      const label = `${company.taxId} ${company.businessName}: ${pending.length} actions to load, then closed ("${REMOVED_REASON}")`
      if (!apply) {
        logger.info(`${label}${state.inCrm ? " (already in the CRM)" : state.exists ? " (in the graph)" : " (new)"}`)
        continue
      }
      try {
        await companies.addCompany(company, by)
      } catch (err) {
        if (!(err instanceof CrmError && err.reason === "already_in_crm")) throw err
      }
      const existingContacts = await repository.listContacts(company.taxId)
      for (const person of people.contacts.filter((item) => item.companyTaxIds.includes(company.taxId))) {
        if (existingContacts.some((other) => nameKey(other.fullName) === nameKey(person.fullName))) continue
        await contacts.createContact({ ...person, companyTaxIds: [company.taxId] }, by)
      }
      const loaded = await loadCompanyHistory(work, company.taxId, pending, by, (step, message) => logger.error(`  ${step.date} ✗ ${message}`))
      const people = await repository.listContacts(company.taxId)
      for (const action of await repository.listActions(company.taxId)) {
        const mention = contactInDescription(action.description)
        const person = mention && people.find((other) => nameKey(other.fullName) === nameKey(mention.name))
        if (!mention || !person || action.contactIds.length > 0) continue
        await work.updateAction(action.id, { contactIds: [person.id], description: mention.rest.trim() || NO_DETAIL }, { username: by, canAdminister: true })
      }
      const current = await repository.findCompany(company.taxId)
      if (current && current.closedAt === null) await companies.closeCompany(company.taxId, REMOVED_REASON, by)
      logger.info(`${company.businessName} ✓ ${loaded.done} actions, closed`)
    }
    if (!apply) logger.warn("Dry run: nothing was written. Add --apply to load.")
  } finally {
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
