import { deudoresSourceName } from "@domain/deudores.js"

export const FINANCIERA_SOURCE = "Deudores por financiera"

const BANK_SOURCE_PREFIX = "Deudores "
const SAMPLE_SIZE = 3

export interface BankOperationsPlan {
  financiera: unknown[]
  bank: unknown[]
  moved: unknown[]
  bankBefore: number
}

export interface BankMigrationSample {
  taxId: string
  financieraBefore: number
  financieraAfter: number
  bankBefore: number
  bankAfter: number
}

export interface BankMigrationTally {
  examined: number
  affected: number
  moved: number
  byEntity: Record<string, number>
  samples: BankMigrationSample[]
}

export function isBankSource(name: string): boolean {
  return name.startsWith(BANK_SOURCE_PREFIX) && name !== FINANCIERA_SOURCE
}

function parseOperations(raw: unknown): unknown[] | null {
  if (raw == null || raw === "") return []
  if (typeof raw !== "string") return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function entityNameOf(operation: unknown): string {
  if (typeof operation !== "object" || operation === null) return ""
  const name = (operation as { entityName?: unknown }).entityName
  return typeof name === "string" ? name : ""
}

function belongsToBank(operation: unknown, bankSources: Set<string>): boolean {
  const entityName = entityNameOf(operation)
  return entityName !== "" && bankSources.has(deudoresSourceName(entityName))
}

function unique(operations: unknown[]): unknown[] {
  const seen = new Set<string>()
  return operations.filter((operation) => {
    const fingerprint = JSON.stringify(operation)
    if (seen.has(fingerprint)) return false
    seen.add(fingerprint)
    return true
  })
}

export function planBankOperations(
  sources: string[],
  financieraRaw: unknown,
  bankRaw: unknown
): BankOperationsPlan | null {
  const financiera = parseOperations(financieraRaw)
  const bank = parseOperations(bankRaw)
  if (!financiera || !bank) return null

  const bankSources = new Set(sources.filter(isBankSource))
  const moved = financiera.filter((operation) => belongsToBank(operation, bankSources))
  if (moved.length === 0) return null

  return {
    financiera: financiera.filter((operation) => !belongsToBank(operation, bankSources)),
    bank: unique([...bank, ...moved]),
    moved,
    bankBefore: bank.length,
  }
}

export function emptyBankMigrationTally(): BankMigrationTally {
  return { examined: 0, affected: 0, moved: 0, byEntity: {}, samples: [] }
}

export function tallyBankMigration(
  tally: BankMigrationTally,
  taxId: string,
  plan: BankOperationsPlan | null
): void {
  tally.examined += 1
  if (!plan) return

  tally.affected += 1
  tally.moved += plan.moved.length
  for (const operation of plan.moved) {
    const entityName = entityNameOf(operation)
    tally.byEntity[entityName] = (tally.byEntity[entityName] ?? 0) + 1
  }
  if (tally.samples.length < SAMPLE_SIZE) {
    tally.samples.push({
      taxId,
      financieraBefore: plan.financiera.length + plan.moved.length,
      financieraAfter: plan.financiera.length,
      bankBefore: plan.bankBefore,
      bankAfter: plan.bank.length,
    })
  }
}

export function describeBankMigration(tally: BankMigrationTally, apply: boolean): string[] {
  const lines = [
    `CUITs examined: ${tally.examined}`,
    `CUITs affected: ${tally.affected}`,
    `Operations ${apply ? "moved" : "to move"}: ${tally.moved}`,
  ]
  const entities = Object.entries(tally.byEntity).sort(([a], [b]) => a.localeCompare(b))
  for (const [entityName, count] of entities) lines.push(`  ${entityName}: ${count}`)
  for (const sample of tally.samples) {
    lines.push(
      `Sample ${sample.taxId}: financieraOperations ${sample.financieraBefore} -> ${sample.financieraAfter}, ` +
        `bankOperations ${sample.bankBefore} -> ${sample.bankAfter}`
    )
  }
  return lines
}
