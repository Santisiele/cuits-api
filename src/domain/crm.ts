import { isSameUser } from "@domain/users.js"

export const CRM_SOURCE_NAME = "CRM Excel"

export const MAX_NAME_LENGTH = 200
export const MAX_TEXT_LENGTH = 2000

export type CrmRejection =
  | "invalid_cuit"
  | "business_name_required"
  | "full_name_required"
  | "company_required"
  | "invalid_date"
  | "text_too_long"
  | "company_not_in_crm"
  | "already_in_crm"
  | "contact_not_found"
  | "already_archived"
  | "not_archived"
  | "cuil_already_set"
  | "description_required"
  | "cancel_reason_required"
  | "invalid_status"
  | "task_not_open"
  | "task_other_company"
  | "forbidden"
  | "action_not_found"
  | "task_not_found"
  | "user_not_found"
  | "invalid_entity"

export type RemovalOutcome = "unlinked" | "archived" | "deleted"

export type ChangeEntityType = "Action" | "Task" | "Contact" | "CrmCompany" | "User"

export type ChangeOperation =
  | "create"
  | "update"
  | "archive"
  | "restore"
  | "complete"
  | "cancel"
  | "crm_add"
  | "crm_remove"

export interface CrmCompanyFields {
  crmBrand: string | null
  crmProduct: string | null
  crmOrigin: string | null
}

export interface CrmCompany extends CrmCompanyFields {
  taxId: string
  businessName: string
  nosisPending: boolean
  addedAt: string | null
  addedBy: string | null
  lastActionDate: string | null
  nextDueDate: string | null
  openTaskCount: number
}

export interface CrmCuitState {
  exists: boolean
  inCrm: boolean
  archived: boolean
  nosisSearched: boolean
  inKnownSource: boolean
}

export interface RemovalFacts {
  hasHistory: boolean
  hasOtherSource: boolean
  relatedToBase: boolean
  openTaskIds: string[]
}

export type TaskStatus = "open" | "done" | "cancelled"

export interface Action {
  id: string
  companyTaxId: string
  date: string
  description: string
  doneBy: string
  contactIds: string[]
  createdTaskId: string | null
  completedTaskIds: string[]
  createdAt: string
  archivedAt: string | null
}

export interface Task {
  id: string
  companyTaxId: string
  description: string
  dueDate: string
  status: TaskStatus
  cancelReason: string | null
  assignee: string
  createdBy: string
  contactIds: string[]
  createdAt: string
  closedAt: string | null
  archivedAt: string | null
}

export interface AgendaItem extends Task {
  businessName: string
  overdue: boolean
}

export interface Actor {
  username: string
  canAdminister: boolean
}

export const COMPANY_REMOVED_REASON = "company_removed"

export const CHANGE_ENTITY_TYPES: readonly ChangeEntityType[] = ["Action", "Task", "Contact", "CrmCompany", "User"]

export interface Contact {
  id: string
  fullName: string
  phone: string | null
  email: string | null
  birthday: string | null
  cuil: string | null
  companyTaxIds: string[]
  createdAt: string
  archivedAt: string | null
}

export interface ContactInput {
  fullName: string
  phone: string | null
  email: string | null
  birthday: string | null
}

export interface Change {
  id: string
  at: string
  by: string
  entityType: ChangeEntityType
  entityId: string
  operation: ChangeOperation
  before: Record<string, unknown>
  after: Record<string, unknown>
}

const CUIT_PATTERN = /^\d{11}$/
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BIRTHDAY_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const BUENOS_AIRES_OFFSET_HOURS = 3

export function isValidCrmCuit(value: unknown): value is string {
  return typeof value === "string" && CUIT_PATTERN.test(value)
}

export function isValidCrmId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value)
}

export function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function isValidBirthday(value: string): boolean {
  const match = BIRTHDAY_PATTERN.exec(value)
  if (!match) return false
  return isRealDate(Number(match[3]), Number(match[2]), Number(match[1]))
}

export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

export function isTooLong(value: string | null, max: number): boolean {
  return value !== null && value.length > max
}

export function shouldMarkNosisPending(state: CrmCuitState): boolean {
  if (!state.exists) return true
  return !state.nosisSearched && !state.inKnownSource
}

export function removalOutcome(facts: RemovalFacts): RemovalOutcome {
  if (facts.hasHistory) return "archived"
  if (!facts.hasOtherSource && !facts.relatedToBase) return "deleted"
  return "unlinked"
}

export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const changedBefore: Record<string, unknown> = {}
  const changedAfter: Record<string, unknown> = {}
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue
    changedBefore[key] = before[key] ?? null
    changedAfter[key] = after[key] ?? null
  }
  return { before: changedBefore, after: changedAfter }
}

export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false
  const match = CALENDAR_DATE_PATTERN.exec(value)
  if (!match) return false
  return isRealDate(Number(match[1]), Number(match[2]), Number(match[3]))
}

export function todayInBuenosAires(now: Date): string {
  return new Date(now.getTime() - BUENOS_AIRES_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10)
}

export function isOverdue(dueDate: string, today: string): boolean {
  return dueDate < today
}

export function taskStatusRejection(task: Task, next: unknown, cancelReason: string | null): CrmRejection | null {
  if (next !== "done" && next !== "cancelled") return "invalid_status"
  if (task.status !== "open") return "task_not_open"
  if (next === "cancelled" && cancelReason === null) return "cancel_reason_required"
  return null
}

export function canChangeAction(actor: Actor, action: Action): boolean {
  return actor.canAdminister || isSameUser(actor.username, action.doneBy)
}

export function canChangeTask(actor: Actor, task: Task): boolean {
  return actor.canAdminister || isSameUser(actor.username, task.createdBy) || isSameUser(actor.username, task.assignee)
}

export function sortAgenda(items: AgendaItem[]): AgendaItem[] {
  return [...items].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.businessName.localeCompare(b.businessName) || a.id.localeCompare(b.id)
  )
}

export function isChangeEntityType(value: unknown): value is ChangeEntityType {
  return typeof value === "string" && (CHANGE_ENTITY_TYPES as readonly string[]).includes(value)
}

export function uniqueIds(values: unknown): string[] | null {
  if (values === undefined || values === null) return []
  if (!Array.isArray(values)) return null
  const unique = [...new Set(values)]
  return unique.every(isValidCrmId) ? unique : null
}

export function uniqueTaxIds(values: unknown): string[] | null {
  if (!Array.isArray(values)) return null
  const unique = [...new Set(values)]
  return unique.every(isValidCrmCuit) ? unique : null
}
