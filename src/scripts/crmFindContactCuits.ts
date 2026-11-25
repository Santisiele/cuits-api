import "dotenv/config"
import fs from "fs"
import path from "path"
import XLSX from "xlsx"
import { config } from "@config.js"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { CrmContactService } from "@application/CrmContactService.js"
import { NosisScraper } from "@scrapers/nosis.js"
import { isProductionUri } from "@domain/crmImport.js"
import {
  CONTACT_CUIT_HEADERS,
  NOT_FOUND_STATUS,
  ONE_WORD_STATUS,
  SUGGESTED_STATUS,
  SURE_STATUS,
  onlyMatch,
  peopleInTree,
  searchable,
} from "@domain/crmContactCuits.js"

const USAGE = [
  "Usage: pnpm crm:find-contact-cuits [out.xlsx] [--count N] [--dry-run]",
  "       pnpm crm:find-contact-cuits --load <file.xlsx> [--by admin] [--apply] [--production]",
].join("\n")

const FIND_CONTACTS_WITHOUT_CUIL = `
  MATCH (k:Contact)-[:WORKS_AT]->(c:CUIT)
  WHERE k.archivedAt IS NULL AND c.crmCompany = true AND NOT (k)-[:IS]->(:CUIT)
  RETURN k.id AS id, k.fullName AS fullName, c.id AS taxId, c.businessName AS businessName
  ORDER BY toLower(c.businessName), toLower(k.fullName)
`

const CUIT_BIRTHDAY = `MATCH (c:CUIT {id: $taxId}) RETURN c.birthday AS birthday`

type Row = Record<(typeof CONTACT_CUIT_HEADERS)[number], string>

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function wait(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
  logger.info(`  waiting ${(ms / 1000).toFixed(0)}s...`)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readRows(file: string): Row[] {
  if (!fs.existsSync(file)) return []
  const book = XLSX.readFile(file)
  const sheet = book.Sheets[book.SheetNames[0]!]!
  return XLSX.utils.sheet_to_json<Row>(sheet, { defval: "", raw: false })
}

function save(file: string, rows: Row[]): void {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: [...CONTACT_CUIT_HEADERS] })
  sheet["!cols"] = [{ wch: 30 }, { wch: 34 }, { wch: 13 }, { wch: 13 }, { wch: 34 }, { wch: 46 }, { wch: 38 }, { wch: 38 }]
  if (sheet["!ref"]) sheet["!autofilter"] = { ref: sheet["!ref"] }
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, "Contactos")
  try {
    XLSX.writeFile(book, file)
  } catch (err) {
    throw new Error(`Could not save ${file}. Close it in Excel and run again. ${(err as Error).message}`)
  }
}

async function contactsWithoutCuil(): Promise<Row[]> {
  const session = Neo4jDriver.instance.session({ defaultAccessMode: "READ" })
  try {
    const result = await session.run(FIND_CONTACTS_WITHOUT_CUIL)
    return result.records.map((record) => ({
      Contacto: String(record.get("fullName")),
      Empresa: String(record.get("businessName") ?? ""),
      "CUIT empresa": String(record.get("taxId")),
      CUIL: "",
      "Nombre en Nosis": "",
      Sugerencia: "",
      Estado: "",
      Id: String(record.get("id")),
    }))
  } finally {
    await session.close()
  }
}

async function search(file: string, count: number, dryRun: boolean): Promise<void> {
  const previous = new Map(readRows(file).map((row) => [`${row.Id}|${row["CUIT empresa"]}`, row]))
  const rows = (await contactsWithoutCuil()).map((row) => previous.get(`${row.Id}|${row["CUIT empresa"]}`) ?? row)
  const companies = [...new Set(rows.filter((row) => row.Estado === "").map((row) => row["CUIT empresa"]))].slice(0, count)
  const searchableCount = rows.filter((row) => companies.includes(row["CUIT empresa"]) && searchable(row.Contacto)).length
  logger.info(`${rows.length} contact rows without CUIL, ${companies.length} companies to look up, ${searchableCount} contacts with name and surname`)

  if (dryRun) {
    for (const taxId of companies) {
      const people = rows.filter((row) => row["CUIT empresa"] === taxId)
      logger.info(`${taxId} ${people[0]!.Empresa}: ${people.map((row) => row.Contacto).join(", ")}`)
    }
    logger.warn("Dry run: nothing was sent to Nosis.")
    return
  }

  logger.info("Logging into Nosis...")
  const scraper = await NosisScraper.create()
  let sure = 0
  let suggested = 0

  for (const [index, taxId] of companies.entries()) {
    const pending = rows.filter((row) => row["CUIT empresa"] === taxId && row.Estado === "")
    logger.info(`[${index + 1}/${companies.length}] ${taxId} ${pending[0]!.Empresa}`)
    try {
      const tree = pending.some((row) => searchable(row.Contacto)) ? await scraper.fetchRelations(taxId, pending[0]!.Empresa) : []
      const people = peopleInTree(tree)
      for (const row of pending) {
        if (!searchable(row.Contacto)) {
          row.Estado = ONE_WORD_STATUS
          continue
        }
        const match = onlyMatch(row.Contacto, people)
        if (match) {
          row.CUIL = match.taxId
          row["Nombre en Nosis"] = match.businessName
          row.Estado = SURE_STATUS
          sure++
          logger.info(`  ${row.Contacto} → ${match.taxId} ${match.businessName}`)
          continue
        }
        await wait(10_000, 25_000)
        const guess = onlyMatch(row.Contacto, await scraper.searchPeopleByName(row.Contacto))
        if (guess) {
          row.Sugerencia = `${guess.taxId} ${guess.businessName}`
          row.Estado = SUGGESTED_STATUS
          suggested++
          logger.info(`  ${row.Contacto} ? ${guess.taxId} ${guess.businessName}`)
        } else {
          row.Estado = NOT_FOUND_STATUS
          logger.info(`  ${row.Contacto} → no sure match`)
        }
      }
    } catch (err) {
      logger.error(`  ${(err as Error).message}`)
    }
    save(file, rows)
    if (index < companies.length - 1) await wait(10_000, 25_000)
  }

  logger.info(`Done: ${sure} sure, ${suggested} suggestions to review. Wrote ${file}`)
  logger.info(`Only the CUIL column is loaded: pnpm crm:find-contact-cuits --load "${file}" [--apply --production]`)
}

async function load(file: string, by: string, apply: boolean, production: boolean): Promise<void> {
  if (apply && isProductionUri(config.neo4j.uri) && !production) {
    throw new Error("That is the production Aura. Add --production if you really mean it.")
  }
  const repository = new Neo4jCrmRepository()
  const contacts = new CrmContactService(repository)
  const tally = { linked: 0, birthdays: 0, skipped: 0, failed: 0 }

  for (const row of readRows(file)) {
    const cuil = String(row.CUIL ?? "").replace(/\D/g, "")
    if (!cuil || !row.Id) continue
    const contact = await repository.findContact(row.Id)
    if (!contact || contact.archivedAt !== null || contact.cuil !== null) {
      tally.skipped++
      continue
    }
    logger.info(`${apply ? "" : "would link "}${contact.fullName} (${row.Empresa}) → ${cuil}`)
    tally.linked++
    if (!apply) continue
    try {
      await contacts.updateContact(contact.id, { cuil }, by)
      const session = Neo4jDriver.instance.session({ defaultAccessMode: "READ" })
      const birthday = String((await session.run(CUIT_BIRTHDAY, { taxId: cuil })).records[0]?.get("birthday") ?? "").trim()
      await session.close()
      if (birthday) tally.birthdays += await contacts.fillBirthday(cuil, birthday, by)
    } catch (err) {
      tally.failed++
      logger.error(`  ✗ ${(err as Error).message}`)
    }
  }

  logger.info(`Linked: ${tally.linked}, birthdays copied: ${tally.birthdays}, skipped: ${tally.skipped}, failed: ${tally.failed}`)
  if (!apply) logger.warn("Dry run: nothing was written. Add --apply to load.")
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const loadFile = valueAfter(args, "--load")
  const countArg = valueAfter(args, "--count")
  const count = countArg === undefined ? Infinity : Number(countArg)
  const flagsWithValue = new Set(["--load", "--count", "--by"])
  const output = args.find((arg, index) => !arg.startsWith("--") && !flagsWithValue.has(args[index - 1] ?? ""))
  if (Number.isNaN(count) || count < 1) throw new Error(USAGE)

  try {
    if (loadFile) await load(path.resolve(loadFile), valueAfter(args, "--by") ?? "admin", args.includes("--apply"), args.includes("--production"))
    else await search(path.resolve(output ?? "Contactos CUIL Nosis.xlsx"), count, args.includes("--dry-run"))
  } finally {
    await Neo4jDriver.close()
  }
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})
