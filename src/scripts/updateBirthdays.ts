import "dotenv/config"
import XLSX from "xlsx"
import { logger } from "@logger.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"

/**
 * One-off script: read an Excel file with two columns (CUIT, birthday) and
 * update the `birthday` field of matching CUIT nodes already in Neo4j.
 *
 * Semantics (per user spec):
 *   - CUIT not found in the graph → skip and log
 *   - CUIT already has a birthday → overwrite it (Excel is the source of truth)
 *   - Row without a valid CUIT     → skip and log
 *   - Row without a valid date     → skip and log
 *
 * Date parsing accepts:
 *   - Excel serial numbers (typed as "date" cells in the workbook — this is
 *     what you get when Excel formats the cell as a date rather than text)
 *   - Strings in dd/mm/yyyy or d/m/yyyy or any 1-2 digit day/month combo
 *   - ISO strings (yyyy-mm-dd) as a safety net
 *
 * Usage:
 *   pnpm tsx src/scripts/updateBirthdays.ts <inputPath> [startRow] [count]
 *
 * Example:
 *   pnpm tsx src/scripts/updateBirthdays.ts ./sources/cumpleanos.xlsx
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const UPDATE_QUERY = `
  MATCH (c:CUIT {id: $taxId})
  SET c.birthday = $birthday
  RETURN c.id AS taxId
`

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strips every non-digit; returns "" if nothing remains. */
function digitsOnly(raw: unknown): string {
  if (raw == null) return ""
  return String(raw).replace(/\D/g, "")
}

/**
 * Heuristic for "is this cell an Excel date serial?".
 * Range covers ~1900-01-01 (serial 1) up to ~2100 (serial ~73050).
 * That includes people born in 1901 (real: fila 19 tiene un 1/1/1901).
 * We DON'T lower the threshold below 1 because 0 and negative values
 * are certainly not real birthdays.
 */
function looksLikeExcelDateSerial(value: unknown): value is number {
  return typeof value === "number" && value >= 1 && value < 73_050
}

/**
 * Converts an Excel serial date (Lotus epoch, days since 1900-01-01) to
 * a dd/mm/yyyy string using UTC to avoid timezone drift.
 * Returns "" for invalid serials.
 */
function excelSerialToDdMmYyyy(serial: number): string {
  const utcMs = (serial - 25569) * 86400 * 1000
  const date = new Date(utcMs)
  if (isNaN(date.getTime())) return ""
  const day = String(date.getUTCDate()).padStart(2, "0")
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const year = date.getUTCFullYear()
  return `${day}/${month}/${year}`
}

/**
 * Normalises whatever comes in the birthday cell into a canonical
 * dd/mm/yyyy string. Returns "" if it's unparseable.
 *
 * Accepted:
 *   - Excel date serial (number)
 *   - Native JS Date object (some XLSX modes emit these)
 *   - String in d/m/yyyy, dd/m/yyyy, d/mm/yyyy, dd/mm/yyyy (with / or -)
 *   - ISO yyyy-mm-dd string
 *
 * The parsing is strict about the range (day 1-31, month 1-12) and about
 * the year being 4 digits — 2-digit years are ambiguous and rejected here.
 */
function normaliseBirthday(raw: unknown): string {
  if (raw == null || raw === "") return ""

  if (looksLikeExcelDateSerial(raw)) return excelSerialToDdMmYyyy(raw)

  if (raw instanceof Date && !isNaN(raw.getTime())) {
    const day = String(raw.getUTCDate()).padStart(2, "0")
    const month = String(raw.getUTCMonth() + 1).padStart(2, "0")
    const year = raw.getUTCFullYear()
    return `${day}/${month}/${year}`
  }

  const s = String(raw).trim()
  if (!s) return ""

  // d/m/yyyy or dd/mm/yyyy (with / or -)
  const ddmm = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s)
  if (ddmm) {
    const d = Number(ddmm[1])
    const m = Number(ddmm[2])
    const y = ddmm[3]
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`
    }
    return ""
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (iso) {
    const y = iso[1]
    const m = Number(iso[2])
    const d = Number(iso[3])
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`
    }
    return ""
  }

  return ""
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface RowOutcome {
  rowNumber: number
  cuit: string
  birthday: string
  status: "updated" | "not_found" | "invalid_cuit" | "invalid_date"
}

async function main(): Promise<void> {
  const inputPath = process.argv[2]
  if (!inputPath) {
    throw new Error("Usage: updateBirthdays <inputPath> [startRow] [count]")
  }

  const startRow = Number(process.argv[3] ?? 1)
  const count    = Number(process.argv[4] ?? 1_000_000)

  if (isNaN(startRow) || startRow < 1) throw new Error("startRow must be a positive number")
  if (isNaN(count)    || count    < 1) throw new Error("count must be a positive number")

  logger.info(`Input: ${inputPath}`)

  const workbook = XLSX.readFile(inputPath, { cellDates: false })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new Error("Workbook has no sheets")
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`)

  const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: true,
  })
  if (allRows.length < 2) throw new Error("File has no data rows")

  const dataRows = allRows.slice(1) as unknown[][]
  const slice = dataRows.slice(startRow - 1, startRow - 1 + count)

  logger.info(`Loaded ${slice.length} rows`)

  const session = Neo4jDriver.instance.session()
  const outcomes: RowOutcome[] = []

  try {
    for (let i = 0; i < slice.length; i++) {
      const row = slice[i]!
      const rowNumber = startRow + i
      const cuit = digitsOnly(row[0])
      const birthday = normaliseBirthday(row[1])

      const label = `[${i + 1}/${slice.length}] row ${rowNumber}: ${cuit || "(no cuit)"} → ${birthday || "(invalid date)"}`

      if (!cuit) {
        logger.warn(`${label} ✗ invalid_cuit`)
        outcomes.push({ rowNumber, cuit, birthday, status: "invalid_cuit" })
        continue
      }
      if (!birthday) {
        logger.warn(`${label} ✗ invalid_date`)
        outcomes.push({ rowNumber, cuit, birthday, status: "invalid_date" })
        continue
      }

      const result = await session.run(UPDATE_QUERY, { taxId: cuit, birthday })
      if (result.records.length === 0) {
        logger.warn(`${label} ✗ not_found`)
        outcomes.push({ rowNumber, cuit, birthday, status: "not_found" })
      } else {
        logger.info(`${label} ✓ updated`)
        outcomes.push({ rowNumber, cuit, birthday, status: "updated" })
      }
    }
  } finally {
    await session.close()
    await Neo4jDriver.close()
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const counts = { updated: 0, not_found: 0, invalid_cuit: 0, invalid_date: 0 }
  for (const o of outcomes) counts[o.status]++

  logger.info("─── Summary ─────────────────────────────────")
  logger.info(`Updated:      ${counts.updated}`)
  logger.info(`Not found:    ${counts.not_found}`)
  logger.info(`Invalid CUIT: ${counts.invalid_cuit}`)
  logger.info(`Invalid date: ${counts.invalid_date}`)
  logger.info(`Total:        ${outcomes.length}`)
}

main().catch((err) => {
  logger.error(err)
  process.exit(1)
})