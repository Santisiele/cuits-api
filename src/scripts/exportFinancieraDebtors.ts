import "dotenv/config"
import XLSX from "xlsx"
import path from "path"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { FINANCIERA_SOURCE } from "@domain/bankOperations.js"
import { summariseLenders } from "@domain/financieraLenders.js"

const FIND_FINANCIERA_DEBTORS = `
  MATCH (c:CUIT)-[:HAS_SOURCE]->(:Source {name: $source})
  RETURN c.id AS taxId, c.businessName AS businessName, c.financieraOperations AS operations
`

const normalised = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim()

const [search, output] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))

const session = Neo4jDriver.instance.session({ defaultAccessMode: "READ" })
try {
  const result = await session.run(FIND_FINANCIERA_DEBTORS, { source: FINANCIERA_SOURCE })
  const debtors = result.records.map((record) => ({
    taxId: String(record.get("taxId")),
    businessName: String(record.get("businessName") ?? ""),
    lenders: summariseLenders({ financieraOperations: record.get("operations") }, "financieraOperations"),
  }))

  if (!search) {
    const counts = new Map<string, number>()
    for (const debtor of debtors) for (const lender of debtor.lenders) counts.set(lender.entityName, (counts.get(lender.entityName) ?? 0) + 1)
    for (const [name, count] of [...counts].sort((a, b) => b[1] - a[1])) logger.info(`${count}\t${name}`)
    logger.info(`${counts.size} financieras. Usage: pnpm export:financiera "<financiera>" [output.xlsx]`)
  } else {
    const wanted = normalised(search)
    const rows = debtors.flatMap((debtor) =>
      debtor.lenders
        .filter((lender) => normalised(lender.entityName).includes(wanted))
        .flatMap((lender) =>
          lender.months.map((month) => ({
            CUIT: debtor.taxId,
            "Razón social": debtor.businessName,
            Financiera: lender.entityName,
            Período: month.period,
            Situación: month.situation,
            "Monto ($)": month.totalLoan,
          }))
        )
    )
    rows.sort((a, b) => a.Financiera.localeCompare(b.Financiera) || a["Razón social"].localeCompare(b["Razón social"]) || b.Período.localeCompare(a.Período))

    const sheet = XLSX.utils.json_to_sheet(rows, { header: ["CUIT", "Razón social", "Financiera", "Período", "Situación", "Monto ($)"] })
    sheet["!cols"] = [{ wch: 14 }, { wch: 44 }, { wch: 36 }, { wch: 10 }, { wch: 10 }, { wch: 16 }]
    if (sheet["!ref"]) sheet["!autofilter"] = { ref: sheet["!ref"] }
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, sheet, "Deudores")
    const target = path.resolve(output ?? `Deudores ${search.replace(/[\\/:*?"<>|]/g, "")}.xlsx`)
    XLSX.writeFile(book, target)

    const companies = new Set(rows.map((row) => row.CUIT)).size
    const lenders = [...new Set(rows.map((row) => row.Financiera))]
    logger.info(`${companies} CUITs, ${rows.length} rows, financieras: ${lenders.join(", ") || "none matched"}`)
    logger.info(`Wrote ${target}`)
  }
} finally {
  await session.close()
  await Neo4jDriver.close()
}
