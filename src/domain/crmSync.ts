import { contactInDescription } from "@domain/crmContactImport.js"
import { nameKey, type HistoryStep } from "@domain/crmHistoryImport.js"
import { sameResponsible } from "@domain/responsibles.js"
import { isValidCalendarDate, type Action, type Task } from "@domain/crm.js"

export type SyncChange =
  | { kind: "new"; step: HistoryStep }
  | { kind: "postpone"; step: HistoryStep; task: Task; dueDate: string }
  | { kind: "edit"; step: HistoryStep; task: Task; fields: { dueDate?: string; assignee?: string; description?: string } }
  | { kind: "text"; step: HistoryStep; action: Action }
  | { kind: "next"; step: HistoryStep; action: Action }

const SAME_START = 25

function said(description: string): string {
  return nameKey(contactInDescription(description)?.rest ?? description)
}

function sameAction(action: Action, step: HistoryStep): boolean {
  if (action.date !== step.date) return false
  const [a, b] = [said(action.description), said(step.description)]
  return a === b || (Math.min(a.length, b.length) >= SAME_START && (a.startsWith(b) || b.startsWith(a)))
}

export function syncChanges(steps: readonly HistoryStep[], actions: readonly Action[], tasks: readonly Task[]): SyncChange[] {
  const changes: SyncChange[] = []
  for (const step of steps) {
    if (!isValidCalendarDate(step.date)) continue
    const action = actions.find((candidate) => sameAction(candidate, step))
    if (!action) {
      changes.push({ kind: "new", step })
      continue
    }
    if (said(action.description) !== said(step.description)) changes.push({ kind: "text", step, action })
    const task = tasks.find((candidate) => candidate.id === action.createdTaskId)
    if (!task && step.nextTask && step === steps[steps.length - 1] && !tasks.some((other) => other.status === "open")) changes.push({ kind: "next", step, action })
    if (!task || task.status !== "open" || !step.nextTask) continue
    const next = step.nextTask
    const fields: { dueDate?: string; assignee?: string; description?: string } = {}
    if (!sameResponsible(next.assignee, task.assignee)) fields.assignee = next.assignee
    if (nameKey(next.description) !== nameKey(task.description)) fields.description = next.description
    if (next.dueDate < task.dueDate) fields.dueDate = next.dueDate
    if (next.dueDate > task.dueDate) changes.push({ kind: "postpone", step, task, dueDate: next.dueDate })
    if (Object.keys(fields).length > 0) changes.push({ kind: "edit", step, task, fields })
  }
  return changes
}

export function taskToComplete(openTasks: readonly Task[], actions: readonly Action[], contactIdsByName: ReadonlyMap<string, string>, step: HistoryStep): Task | null {
  if (openTasks.length === 0) return null
  if (openTasks.length === 1) return openTasks[0]!
  const contactId = contactIdsByName.get(nameKey(contactInDescription(step.description)?.name ?? ""))
  const byContact = openTasks.find((task) => actions.some((action) => action.createdTaskId === task.id && contactId !== undefined && action.contactIds.includes(contactId)))
  return byContact ?? [...openTasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!
}
