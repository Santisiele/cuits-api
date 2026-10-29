import "dotenv/config"
import XLSX from "xlsx"
import { logger } from "@logger.js"
import { config } from "@config.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { CrmService } from "@application/CrmService.js"
import { isProductionUri, parseCompanyList } from "@domain/crmImport.js"
import { companiesByContact, parseAliases, parseHistory, responsiblesIn } from "@domain/crmHistoryImport.js"
import { responsibleKey } from "@domain/responsibles.js"

const USAGE =
  'Usage: pnpm crm:import-history <file.xlsx> [--by <app user>] [--alias "luc=Luchi"]... [--create-responsibles] [--apply] [--production]'

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]!] : []))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flagsWithValue = new Set(["--by", "--alias"])
  const file = args.find((arg, index) => !arg.startsWith("--") && !flagsWithValue.has(args[index - 1] ?? ""))
  if (!file) throw new Error(USAGE)
  const apply = args.includes("--apply")
  const createResponsibles = args.includes("--create-responsibles")
  const loader = valuesAfter(args, "--by")[0] ?? "admin"
  const aliases = parseAliases(valuesAfter(args, "--alias"))

  const uri = config.neo4j.uri
  logger.info(`Target database: ${uri}`)
  if (apply && isProductionUri(uri) && !args.includes("--production")) {
    throw new Error("That is the production Aura. Point NEO4J_URI at staging, or add --production if you really mean it.")
  }

  const workbook = XLSX.readFile(file)
  const listas = workbook.Sheets["Listas"]
  const seguimiento = workbook.Sheets["Seguimiento"]
  if (!listas || !seguimiento) throw new Error('The file needs the "Listas" and "Seguimiento" sheets')

  const listRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(listas, { defval: "" })
  const companies = parseCompanyList(listRows).companies
  const taxIdByCompany = new Map(companies.map((company) => [company.businessName, company.taxId]))
  const history = parseHistory(
    XLSX.utils.sheet_to_json<Record<string, unknown>>(seguimiento, { defval: "" }),
    taxIdByCompany,
    aliases,
    loader,
    companiesByContact(listRows)
  )

  const steps = [...history.byCompany.values()].flat()
  logger.info(`${steps.length} actions for ${history.byCompany.size} companies, ${steps.filter((step) => step.nextTask).length} with a next task`)
  logger.info(`${[...history.unknownCompanies.values()].reduce((a, b) => a + b, 0)} rows skipped from ${history.unknownCompanies.size} companies without a CUIT in Listas, ${history.withoutDate} without a date`)
  for (const name of history.invalidNames) logger.warn(`  name that is not a valid responsible (falls back to ${loader}): ${name}`)

  const repository = new Neo4jCrmRepository()
  const service = new CrmService(repository)

  try {
    const existing = new Set((await repository.listResponsibles()).map((responsible) => responsibleKey(responsible.name)))
    const needed = [...new Map([...responsiblesIn(history)].map((name) => [responsibleKey(name), name])).values()].sort()
    const missing = needed.filter((name) => !existing.has(responsibleKey(name)))
    logger.info(`Responsibles: ${needed.join(", ")}`)
    logger.info(`Missing responsibles: ${missing.length === 0 ? "none" : missing.join(", ")}`)

    const inCrm = new Set(await repository.companiesInCrm([...history.byCompany.keys()]))
    const outside = [...history.byCompany.keys()].filter((taxId) => !inCrm.has(taxId))
    if (outside.length > 0) logger.warn(`${outside.length} companies are not in the CRM and will be skipped: ${outside.join(", ")}`)

    const session = Neo4jDriver.instance.session()
    const actionCount = Number((await session.run("MATCH (a:Action) RETURN count(a) AS total")).records[0]?.get("total") ?? 0)
    await session.close()

    if (!apply) {
      logger.warn("Dry run: nothing was written. Add --apply to load.")
      return
    }
    if (actionCount > 0) throw new Error(`The database already holds ${actionCount} actions. Loading the history twice would duplicate it.`)
    if (missing.length > 0 && !createResponsibles) throw new Error("Some responsibles are missing. Add --create-responsibles.")

    for (const name of missing) {
      await repository.createResponsible({ name, color: "slate", users: [], disabled: false }, new Date().toISOString(), loader)
      logger.info(`  created responsible ${name} (gray, pick a color in Responsables)`)
    }

    let done = 0
    let failed = 0
    for (const [taxId, companySteps] of history.byCompany) {
      if (!inCrm.has(taxId)) continue
      let openTaskId: string | null = null
      for (const step of companySteps) {
        try {
          const result = await service.recordAction(
            {
              companyTaxId: taxId,
              doneBy: step.doneBy,
              date: step.date,
              description: step.description,
              contactIds: [],
              completesTaskIds: openTaskId ? [openTaskId] : [],
              nextTask: step.nextTask,
            },
            { username: loader, canAdminister: true }
          )
          openTaskId = result.nextTask?.id ?? null
          done++
        } catch (err) {
          failed++
          logger.error(`  ${step.businessName} ${step.date} ✗ ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      logger.info(`[${done + failed}/${steps.length}] ${companySteps[0]?.businessName ?? taxId}: ${companySteps.length} actions`)
    }

    logger.info("─── Summary ─────────────────────────────────")
    logger.info(`Responsibles created: ${missing.length}`)
    logger.info(`Actions recorded: ${done}`)
    logger.info(`Failed:           ${failed}`)
  } finally {
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
