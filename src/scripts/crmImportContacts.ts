import "dotenv/config"
import XLSX from "xlsx"
import { config } from "@config.js"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { CrmContactService } from "@application/CrmContactService.js"
import { CrmWorkService } from "@application/CrmWorkService.js"
import { isProductionUri, parseCompanyList } from "@domain/crmImport.js"
import { NO_DETAIL, nameKey } from "@domain/crmHistoryImport.js"
import { foundCompanies } from "@domain/crmMissingCuits.js"
import { contactInDescription, foundContactRows, parseListasContacts } from "@domain/crmContactImport.js"

const USAGE = 'Usage: pnpm crm:import-contacts "<CRM Propio.xlsx>" [--found "<Empresas sin CUIT.xlsx>"] --by <username> [--apply] [--production]'

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flagsWithValue = new Set(["--by", "--found"])
  const crmFile = args.find((arg, index) => !arg.startsWith("--") && !flagsWithValue.has(args[index - 1] ?? ""))
  const foundFile = valueAfter(args, "--found")
  const by = valueAfter(args, "--by")
  if (!crmFile || !by) throw new Error(USAGE)
  const apply = args.includes("--apply")

  const uri = config.neo4j.uri
  logger.info(`Target database: ${uri}`)
  if (apply && isProductionUri(uri) && !args.includes("--production")) {
    throw new Error("That is the production Aura. Point NEO4J_URI at staging, or add --production if you really mean it.")
  }

  const listas = XLSX.utils.sheet_to_json<Record<string, unknown>>(XLSX.readFile(crmFile).Sheets["Listas"]!, { defval: "" })
  const taxIdByCompany = new Map(parseCompanyList(listas).companies.map((company) => [company.businessName, company.taxId]))
  const people = [...listas]
  if (foundFile) {
    const foundRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(XLSX.readFile(foundFile).Sheets["Sin CUIT"]!, { defval: "" })
    const found = foundCompanies(foundRows, listas)
    for (const [name, taxId] of found.taxIdByCompany) taxIdByCompany.set(name, taxId)
    people.push(...foundContactRows(foundRows))
  }
  const parsed = parseListasContacts(people, taxIdByCompany)
  logger.info(`${parsed.contacts.length} people in Listas with a company that has a CUIT, ${parsed.withoutCompany.length} rows whose company has none`)
  for (const item of parsed.withoutCompany) logger.warn(`  no CUIT for the company of ${item.fullName}: ${item.company || "(empty)"}`)
  for (const item of parsed.badBirthdays) logger.warn(`  birthday left out for ${item.fullName}: "${item.value}" is not dd/mm/yyyy`)

  const repository = new Neo4jCrmRepository()
  const contacts = new CrmContactService(repository)
  const work = new CrmWorkService(repository)
  const actor = { username: by, canAdminister: true }
  const tally = { created: 0, existing: 0, companyOutside: 0, failed: 0, linked: 0 }

  try {
    const inCrm = new Set(await repository.companiesInCrm([...new Set(parsed.contacts.flatMap((contact) => contact.companyTaxIds))]))
    const idsByCompany = new Map<string, Map<string, string>>()

    for (const [index, contact] of parsed.contacts.entries()) {
      const companies = contact.companyTaxIds.filter((taxId) => inCrm.has(taxId))
      const label = `[${index + 1}/${parsed.contacts.length}] ${contact.fullName}`
      if (companies.length === 0) {
        tally.companyOutside++
        logger.warn(`${label} its company is not in the CRM yet`)
        continue
      }
      const existing = (await Promise.all(companies.map((taxId) => repository.listContacts(taxId))))
        .flat()
        .find((other) => nameKey(other.fullName) === nameKey(contact.fullName))
      if (existing) {
        tally.existing++
        for (const taxId of companies) idsByCompany.set(taxId, (idsByCompany.get(taxId) ?? new Map()).set(nameKey(contact.fullName), existing.id))
        continue
      }
      if (!apply) {
        tally.created++
        logger.info(`${label} would be created (${[contact.phone, contact.email, contact.birthday && `cumple ${contact.birthday}`, contact.cuil && `CUIL ${contact.cuil}`].filter(Boolean).join(", ") || "only the name"})`)
        continue
      }
      try {
        const created = await contacts.createContact({ ...contact, companyTaxIds: companies }, by)
        tally.created++
        for (const taxId of companies) idsByCompany.set(taxId, (idsByCompany.get(taxId) ?? new Map()).set(nameKey(contact.fullName), created.id))
      } catch (err) {
        tally.failed++
        logger.error(`${label} ✗ ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    for (const [taxId, people] of idsByCompany) {
      for (const action of await repository.listActions(taxId)) {
        const mention = contactInDescription(action.description)
        const contactId = mention ? people.get(nameKey(mention.name)) : undefined
        if (!mention || !contactId || action.contactIds.length > 0) continue
        tally.linked++
        await work.updateAction(action.id, { contactIds: [contactId], description: mention.rest.trim() || NO_DETAIL }, actor)
      }
    }

    logger.info("─── Summary ─────────────────────────────────")
    logger.info(`Contacts ${apply ? "created" : "to create"}: ${tally.created}`)
    logger.info(`Already there:       ${tally.existing}`)
    logger.info(`Company not in CRM:  ${tally.companyOutside}`)
    logger.info(`Failed:              ${tally.failed}`)
    logger.info(`Actions linked:      ${tally.linked}${apply ? "" : " (only to contacts that already exist; the rest link on --apply)"}`)
    if (!apply) logger.warn("Dry run: nothing was written. Add --apply to load.")
  } finally {
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
