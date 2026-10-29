import type { FastifyReply, FastifyRequest } from "fastify"
import { CrmError } from "@application/CrmServiceBase.js"
import { ResponsibleError } from "@application/ResponsibleService.js"
import type { ResponsibleRejection } from "@domain/responsibles.js"
import { canAdminister } from "@domain/users.js"
import type { Action, Actor, CrmRejection, Task } from "@domain/crm.js"

const STATUS_BY_REASON: Record<CrmRejection, number> = {
  invalid_cuit: 400,
  business_name_required: 400,
  full_name_required: 400,
  company_required: 400,
  invalid_date: 400,
  text_too_long: 400,
  company_not_in_crm: 404,
  contact_not_found: 404,
  already_in_crm: 409,
  already_archived: 409,
  not_archived: 409,
  cuil_already_set: 409,
  description_required: 400,
  cancel_reason_required: 400,
  invalid_status: 400,
  task_not_open: 400,
  task_changed: 409,
  task_other_company: 400,
  invalid_entity: 400,
  forbidden: 403,
  action_not_found: 404,
  task_not_found: 404,
  user_not_found: 404,
  next_task_required: 400,
  close_reason_required: 400,
  company_closed: 409,
  not_closed: 409,
  source_not_found: 404,
  responsible_not_found: 404,
  responsible_required: 400,
}

const RESPONSIBLE_STATUS: Record<ResponsibleRejection, number> = {
  invalid_name: 400,
  invalid_color: 400,
  invalid_users: 400,
  invalid_disabled: 400,
  name_taken: 409,
  responsible_not_found: 404,
  user_not_found: 404,
}

function excerpt(text: string): string {
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

export function actionDetails(action: Action): Record<string, unknown> {
  return { companyTaxId: action.companyTaxId, doneBy: action.doneBy, date: action.date, description: excerpt(action.description) }
}

export function taskDetails(task: Task): Record<string, unknown> {
  return {
    companyTaxId: task.companyTaxId,
    assignee: task.assignee,
    dueDate: task.dueDate,
    description: excerpt(task.description),
    cancelReason: task.cancelReason,
  }
}

export function actorOf(request: FastifyRequest): Actor {
  return { username: request.username, canAdminister: canAdminister(request.role) }
}

export function handleError(err: unknown, reply: FastifyReply) {
  if (err instanceof ResponsibleError) {
    return reply.code(RESPONSIBLE_STATUS[err.reason]).send({ error: err.reason, message: err.message })
  }
  if (!(err instanceof CrmError)) throw err
  return reply.code(STATUS_BY_REASON[err.reason]).send({ error: err.reason, message: err.message })
}
