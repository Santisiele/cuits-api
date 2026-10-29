import { randomUUID } from "crypto"
import type { ICrmRepository } from "@ports/interfaces.js"
import {
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  cleanText,
  isTooLong,
  isValidCrmCuit,
  type Action,
  type Change,
  type ChangeEntityType,
  type ChangeOperation,
  type Contact,
  type CrmCompany,
  type CrmRejection,
  type RemovalOutcome,
  type Task,
} from "@domain/crm.js"

export class CrmError extends Error {
  constructor(readonly reason: CrmRejection, message: string) {
    super(message)
    this.name = "CrmError"
  }
}

export interface CompanyAddResult {
  taxId: string
  created: boolean
  restored: boolean
  nosisPending: boolean
}

export interface CompanyRemovalResult {
  outcome: RemovalOutcome
  cancelledTaskCount: number
  dryRun: boolean
}

export interface CompanyDetail {
  company: CrmCompany
  contacts: Contact[]
  actions: Action[]
  tasks: Task[]
}

export interface ActionResult {
  action: Action
  closedTasks: Task[]
  nextTask: Task | null
}

export interface CompanyBody {
  taxId?: unknown
  businessName?: unknown
  crmBrand?: unknown
  crmProduct?: unknown
  crmOrigin?: unknown
  originSource?: unknown
}

export interface CompanyCloseResult {
  company: CrmCompany
  cancelledTaskCount: number
  inservible: boolean
}

export interface ContactBody {
  fullName?: unknown
  companyTaxIds?: unknown
  phone?: unknown
  email?: unknown
  birthday?: unknown
  cuil?: unknown
}

export interface TaskBody {
  companyTaxId?: unknown
  description?: unknown
  dueDate?: unknown
  assignee?: unknown
  contactIds?: unknown
  status?: unknown
  cancelReason?: unknown
}

export interface ActionBody {
  companyTaxId?: unknown
  doneBy?: unknown
  date?: unknown
  description?: unknown
  contactIds?: unknown
  completesTaskIds?: unknown
  nextTask?: TaskBody | null
}

export interface AgendaQuery {
  assignee?: string
  overdueOnly?: string
}

const MESSAGES: Record<CrmRejection, string> = {
  invalid_cuit: "The CUIT must be 11 digits without dashes",
  business_name_required: "A business name is required for a CUIT that is not in the graph",
  full_name_required: "The contact needs a full name",
  company_required: "The contact needs at least one company",
  invalid_date: "The date is not valid",
  text_too_long: "The text is too long",
  company_not_in_crm: "That company is not in the CRM",
  already_in_crm: "That company is already in the CRM",
  contact_not_found: "That contact does not exist",
  already_archived: "It is already archived",
  not_archived: "It is not archived",
  cuil_already_set: "The contact already has a CUIL",
  description_required: "A description is required",
  cancel_reason_required: "A reason is required to cancel a task",
  invalid_status: "A task can only be marked done or cancelled",
  task_not_open: "That task is no longer open",
  task_changed: "That task changed meanwhile, reload it",
  task_other_company: "That task belongs to another company",
  forbidden: "You are not allowed to do this",
  action_not_found: "That action does not exist",
  task_not_found: "That task does not exist",
  user_not_found: "That user does not exist",
  invalid_entity: "Unknown history entry type",
  next_task_required: "Every action has to leave the next task",
  close_reason_required: "A reason is required to close a company",
  company_closed: "That company is closed",
  not_closed: "That company is not closed",
  source_not_found: "That source does not exist",
  responsible_not_found: "That responsible does not exist",
  responsible_required: "Pick who is responsible",
}

export abstract class CrmServiceBase {
  constructor(
    protected readonly repository: ICrmRepository,
    protected readonly now: () => Date = () => new Date(),
    protected readonly newId: () => string = randomUUID
  ) {}

  protected change(
    at: string,
    by: string,
    entityType: ChangeEntityType,
    entityId: string,
    operation: ChangeOperation,
    before: Record<string, unknown>,
    after: Record<string, unknown>
  ): Change {
    return { id: this.newId(), at, by, entityType, entityId, operation, before, after }
  }

  protected async requireCompany(taxId: string): Promise<CrmCompany> {
    this.requireCuit(taxId)
    const company = await this.repository.findCompany(taxId)
    if (!company) this.fail("company_not_in_crm")
    return company
  }

  protected requireCuit(value: unknown): string {
    if (!isValidCrmCuit(value)) this.fail("invalid_cuit")
    return value
  }

  protected name(value: unknown): string | null {
    const text = cleanText(value)
    if (isTooLong(text, MAX_NAME_LENGTH)) this.fail("text_too_long")
    return text
  }

  protected text(value: unknown): string | null {
    const text = cleanText(value)
    if (isTooLong(text, MAX_TEXT_LENGTH)) this.fail("text_too_long")
    return text
  }

  protected fail(reason: CrmRejection): never {
    throw new CrmError(reason, MESSAGES[reason])
  }
}
