import type { FinancieraLender } from "@domain/entities.js"

const AMOUNT_PATTERN = /^\d+$/

interface StoredOperation {
  entityName?: unknown
  totalLoan?: unknown
}

export function summariseLenders(customFields: Record<string, unknown>): FinancieraLender[] {
  const raw = customFields["financieraOperations"]
  if (typeof raw !== "string" || raw.length === 0) return []

  let operations: unknown
  try {
    operations = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(operations)) return []

  const byLender = new Map<string, FinancieraLender>()
  for (const operation of operations as StoredOperation[]) {
    const entityName = typeof operation?.entityName === "string" ? operation.entityName.trim() : ""
    const amount =
      typeof operation?.totalLoan === "string" && AMOUNT_PATTERN.test(operation.totalLoan.trim())
        ? Number(operation.totalLoan.trim())
        : 0

    const lender = byLender.get(entityName) ?? { entityName, operationCount: 0, totalLoan: 0 }
    lender.operationCount++
    lender.totalLoan += amount
    byLender.set(entityName, lender)
  }

  return [...byLender.values()].sort(
    (a, b) => b.totalLoan - a.totalLoan || a.entityName.localeCompare(b.entityName)
  )
}
