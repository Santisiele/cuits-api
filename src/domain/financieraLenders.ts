import type { FinancieraLender, FinancieraLenderMonth } from "@domain/entities.js"

const AMOUNT_PATTERN = /^\d+$/
const DATE_PATTERN = /^\d{1,2}\/(\d{2})\/(\d{4})$/

interface StoredOperation {
  entityName?: unknown
  date?: unknown
  situation?: unknown
  totalLoan?: unknown
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function periodOf(date: unknown): string {
  const match = DATE_PATTERN.exec(trimmed(date))
  return match ? `${match[2]}-${match[1]}` : ""
}

function amountOf(totalLoan: unknown): number {
  const amount = trimmed(totalLoan)
  return AMOUNT_PATTERN.test(amount) ? Number(amount) : 0
}

function newestFirst(a: FinancieraLenderMonth, b: FinancieraLenderMonth): number {
  if (a.period === b.period) return 0
  if (!a.period) return 1
  if (!b.period) return -1
  return a.period < b.period ? 1 : -1
}

export function summariseLenders(customFields: Record<string, unknown>, key: string): FinancieraLender[] {
  const raw = customFields[key]
  if (typeof raw !== "string" || raw.length === 0) return []

  let operations: unknown
  try {
    operations = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(operations)) return []

  const byLender = new Map<string, FinancieraLenderMonth[]>()
  for (const operation of operations as StoredOperation[]) {
    const entityName = trimmed(operation?.entityName)
    const months = byLender.get(entityName) ?? []
    months.push({
      period: periodOf(operation?.date),
      situation: trimmed(operation?.situation),
      totalLoan: amountOf(operation?.totalLoan),
    })
    byLender.set(entityName, months)
  }

  return [...byLender.entries()]
    .map(([entityName, months]) => ({ entityName, months: months.sort(newestFirst) }))
    .sort(
      (a, b) =>
        b.months[0]!.totalLoan - a.months[0]!.totalLoan || a.entityName.localeCompare(b.entityName)
    )
}
