import { todayInBuenosAires } from "@domain/crm.js"

export const NOSIS_PENDING_COMMAND = "pnpm crm:nosis"
export const MAIL_HOUR_IN_BUENOS_AIRES = 3
export const MAX_CONSECUTIVE_FAILURES = 3

const BUENOS_AIRES_OFFSET_HOURS = 3

export interface NosisPendingItem {
  taxId: string
  businessName: string
  sources: string[]
  addedBy: string | null
  addedAt: string | null
}

export type NosisRunEvent =
  | { kind: "searched"; position: number; total: number; item: NosisPendingItem; related: number; relationships: number }
  | { kind: "not_found"; position: number; total: number; item: NosisPendingItem }
  | { kind: "failed"; position: number; total: number; item: NosisPendingItem; message: string }
  | { kind: "aborted"; failures: number }

export interface NosisRunTally {
  searched: number
  notFound: number
  failed: number
}

export function hourInBuenosAires(now: Date): number {
  return new Date(now.getTime() - BUENOS_AIRES_OFFSET_HOURS * 3_600_000).getUTCHours()
}

export function isPendingMailDue(now: Date, lastSentDay: string | null, pendingCount: number): boolean {
  if (pendingCount === 0) return false
  if (hourInBuenosAires(now) < MAIL_HOUR_IN_BUENOS_AIRES) return false
  return lastSentDay !== todayInBuenosAires(now)
}

function formatDay(iso: string | null): string {
  if (!iso) return "fecha desconocida"
  const day = todayInBuenosAires(new Date(iso))
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`
}

export function pendingMailSubject(count: number): string {
  return count === 1 ? "1 CUIT pendiente de Nosis" : `${count} CUITs pendientes de Nosis`
}

export function pendingMailBody(items: NosisPendingItem[]): string {
  const lines = items.map(
    (item) =>
      `- ${item.taxId} ${item.businessName || "(sin nombre)"} — lo agregó ${item.addedBy ?? "alguien"} el ${formatDay(item.addedAt)}`
  )
  return [
    pendingMailSubject(items.length) + ":",
    "",
    ...lines,
    "",
    `Para buscarlos: ${NOSIS_PENDING_COMMAND} [cantidad]`,
    `Para ver la cola sin tocar Nosis: ${NOSIS_PENDING_COMMAND} --dry-run`,
  ].join("\n")
}
