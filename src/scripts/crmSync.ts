import "dotenv/config"
import XLSX from "xlsx"
import { config } from "@config.js"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { CrmWorkService } from "@application/CrmWorkService.js"
import { isProductionUri, parseCompanyList } from "@domain/crmImport.js"
import { NO_DETAIL, nameKey, parseAliases, parseHistory } from "@domain/crmHistoryImport.js"
import { foundCompanies } from "@domain/crmMissingCuits.js"
import { contactInDescription } from "@domain/crmContactImport.js"
import { syncChanges, taskToComplete } from "@domain/crmSync.js"

const USAGE =
  'Usage: pnpm crm:sync "<CRM Propio.xlsx>" --found "<Empresas sin CUIT.xlsx>" --by <username> [--alias "luc=Luchi"]... [--orphan "Polinoa alguien=30602039958"]... [--apply] [--production]'
const POSTPONED_IN_EXCEL = "Cambiada en el Excel"

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]!] : []))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flagsWithValue = new Set(["--by", "--alias", "--orphan", "--found"])
  const file = args.find((arg, index) => !arg.startsWith("--") && !flagsWithValue.has(args[index - 1] ?? ""))
  const foundFile = valuesAfter(args, "--found")[0]
  const by = valuesAfter(args, "--by")[0]
  if (!file || !foundFile || !by) throw new Error(USAGE)
  const apply = args.includes("--apply")
  const actor = { username: by, canAdminister: true }

  const uri = config.neo4j.uri
  logger.info(`Target database: ${uri}`)
  if (apply && isProductionUri(uri) && !args.includes("--production")) {
    throw new Error("That is the production Aura. Point NEO4J_URI at staging, or add --production if you really mean it.")
  }

  const crm = XLSX.readFile(file)
  const listas = XLSX.utils.sheet_to_json<Record<string, unknown>>(crm.Sheets["Listas"]!, { defval: "" })
  const found = foundCompanies(XLSX.utils.sheet_to_json<Record<string, unknown>>(XLSX.readFile(foundFile).Sheets["Sin CUIT"]!, { defval: "" }), listas)
  const taxIdByCompany = new Map(parseCompanyList(listas).companies.map((company) => [company.businessName, company.taxId]))
  for (const [name, taxId] of found.taxIdByCompany) taxIdByCompany.set(name, taxId)
  for (const pair of valuesAfter(args, "--orphan")) {
    const [contact, cuit] = pair.split("=").map((part) => part.trim()) as [string, string]
    taxIdByCompany.set(contact, cuit.replace(/\D/g, ""))
    found.companyByContact.set(nameKey(contact), contact)
  }
  const history = parseHistory(
    XLSX.utils.sheet_to_json<Record<string, unknown>>(crm.Sheets["Seguimiento"]!, { defval: "" }),
    taxIdByCompany,
    parseAliases(valuesAfter(args, "--alias")),
    by,
    found.companyByContact
  )

  const repository = new Neo4jCrmRepository()
  const work = new CrmWorkService(repository)
  const tally = { added: 0, postponed: 0, edited: 0, failed: 0, outside: 0 }

  try {
    for (const [taxId, steps] of history.byCompany) {
      const company = await repository.findCompany(taxId)
      if (!company) {
        tally.outside++
        continue
      }
      const changes = syncChanges(steps, await repository.listActions(taxId), await repository.listTasks(taxId))
      if (changes.length === 0) continue
      const contactIds = new Map((await repository.listContacts(taxId)).map((contact) => [nameKey(contact.fullName), contact.id]))

      for (const change of changes) {
        const where = `${company.businessName} ${change.step.date}`
        try {
          if (change.kind === "postpone") {
            logger.info(`${where}: postpone "${change.task.description.slice(0, 40)}" ${change.task.dueDate} → ${change.dueDate}`)
            if (apply) await work.postponeTask(change.task.id, { dueDate: change.dueDate, reason: POSTPONED_IN_EXCEL }, actor)
            tally.postponed++
            continue
          }
          if (change.kind === "text") {
            const rest = contactInDescription(change.step.description)
            const text = change.action.contactIds.length > 0 && rest ? rest.rest.trim() || NO_DETAIL : change.step.description
            logger.info(`${where}: action text grows to "${text.slice(0, 70)}"`)
            if (apply) await work.updateAction(change.action.id, { description: text }, actor)
            tally.edited++
            continue
          }
          if (change.kind === "next") {
            const next = change.step.nextTask!
            logger.info(`${where}: now has a next task ${next.dueDate} ${next.assignee} "${next.description.slice(0, 40)}"`)
            if (apply) await work.createTask({ companyTaxId: taxId, ...next }, actor)
            tally.added++
            continue
          }
          if (change.kind === "edit") {
            logger.info(`${where}: edit next task ${JSON.stringify(change.fields)}`)
            if (apply) await work.updateTask(change.task.id, change.fields, actor)
            tally.edited++
            continue
          }
          const actions = await repository.listActions(taxId)
          const open = (await repository.listTasks(taxId)).filter((task) => task.status === "open")
          const completes = taskToComplete(open, actions, contactIds, change.step)
          const mention = contactInDescription(change.step.description)
          const contactId = mention ? contactIds.get(nameKey(mention.name)) : undefined
          logger.info(
            `${where}: new action "${change.step.description.slice(0, 50)}"${completes ? ` completes "${completes.description.slice(0, 30)}"` : ""}${change.step.nextTask ? `, next ${change.step.nextTask.dueDate} ${change.step.nextTask.assignee}` : ""}`
          )
          tally.added++
          if (!apply) continue
          await work.importAction(
            {
              companyTaxId: taxId,
              doneBy: change.step.doneBy,
              date: change.step.date,
              description: contactId && mention ? mention.rest.trim() || NO_DETAIL : change.step.description,
              contactIds: contactId ? [contactId] : [],
              completesTaskIds: completes ? [completes.id] : [],
              nextTask: change.step.nextTask,
            },
            actor
          )
        } catch (err) {
          tally.failed++
          logger.error(`${where} ✗ ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    logger.info("─── Summary ─────────────────────────────────")
    logger.info(`New actions:   ${tally.added}`)
    logger.info(`Postponed:     ${tally.postponed}`)
    logger.info(`Edited:        ${tally.edited}`)
    logger.info(`Failed:        ${tally.failed}`)
    logger.info(`Companies not in the CRM: ${tally.outside}`)
    if (!apply) logger.warn("Dry run: nothing was written. Add --apply to load.")
  } finally {
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
