import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { CrmService, CrmError, type AgendaQuery } from "@application/CrmService.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { NosisPendingService } from "@application/NosisPendingService.js"
import { requireCreator } from "@middleware/requireCreator.js"
import { logCrmOperation } from "@auth/activityLogger.js"
import { NOSIS_PENDING_COMMAND } from "@domain/nosisPending.js"
import { canAdminister } from "@domain/users.js"
import type { Actor, CrmRejection } from "@domain/crm.js"

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
}

function actorOf(request: FastifyRequest): Actor {
  return { username: request.username, canAdminister: canAdminister(request.role) }
}

function handleError(err: unknown, reply: FastifyReply) {
  if (!(err instanceof CrmError)) throw err
  return reply.code(STATUS_BY_REASON[err.reason]).send({ error: err.reason, message: err.message })
}

const nullableString = { type: ["string", "null"] } as const

const companySchema = {
  type: "object",
  properties: {
    taxId: { type: "string" },
    businessName: { type: "string" },
    crmBrand: nullableString,
    crmProduct: nullableString,
    crmOrigin: nullableString,
    originSource: nullableString,
    nosisPending: { type: "boolean" },
    addedAt: nullableString,
    addedBy: nullableString,
    lastActionDate: nullableString,
    nextDueDate: nullableString,
    openTaskCount: { type: "number" },
    closedAt: nullableString,
    closedReason: nullableString,
    closedBy: nullableString,
  },
} as const

const contactSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    fullName: { type: "string" },
    phone: nullableString,
    email: nullableString,
    birthday: nullableString,
    cuil: nullableString,
    companyTaxIds: { type: "array", items: { type: "string" } },
    createdAt: { type: "string" },
    archivedAt: nullableString,
  },
} as const

const idList = { type: "array", items: { type: "string" } } as const

const actionSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    companyTaxId: { type: "string" },
    date: { type: "string" },
    description: { type: "string" },
    doneBy: { type: "string" },
    contactIds: idList,
    createdTaskId: nullableString,
    completedTaskIds: idList,
    createdAt: { type: "string" },
    archivedAt: nullableString,
  },
} as const

const taskProperties = {
  id: { type: "string" },
  companyTaxId: { type: "string" },
  description: { type: "string" },
  dueDate: { type: "string" },
  status: { type: "string" },
  cancelReason: nullableString,
  assignee: { type: "string" },
  createdBy: { type: "string" },
  contactIds: idList,
  createdAt: { type: "string" },
  closedAt: nullableString,
  archivedAt: nullableString,
} as const

const taskSchema = { type: "object", properties: taskProperties } as const

const agendaItemSchema = {
  type: "object",
  properties: { ...taskProperties, businessName: { type: "string" }, overdue: { type: "boolean" } },
} as const

const changeSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    at: { type: "string" },
    by: { type: "string" },
    entityType: { type: "string" },
    entityId: { type: "string" },
    operation: { type: "string" },
    before: { type: "object", additionalProperties: true },
    after: { type: "object", additionalProperties: true },
  },
} as const

const taskBodyProperties = {
  companyTaxId: { type: "string" },
  description: { type: "string" },
  dueDate: { type: "string" },
  assignee: nullableString,
  contactIds: idList,
  status: { type: "string" },
  cancelReason: nullableString,
} as const

const actionBodySchema = {
  type: "object",
  properties: {
    companyTaxId: { type: "string" },
    date: { type: "string" },
    description: { type: "string" },
    contactIds: idList,
    completesTaskIds: idList,
    nextTask: { type: ["object", "null"], properties: taskBodyProperties },
  },
} as const

const companyBodySchema = {
  type: "object",
  properties: {
    taxId: { type: "string" },
    businessName: nullableString,
    crmBrand: nullableString,
    crmProduct: nullableString,
    crmOrigin: nullableString,
    originSource: nullableString,
  },
} as const

const contactBodySchema = {
  type: "object",
  properties: {
    fullName: { type: "string" },
    companyTaxIds: { type: "array", items: { type: "string" } },
    phone: nullableString,
    email: nullableString,
    birthday: nullableString,
    cuil: nullableString,
  },
} as const

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
} as const

const errors = { 400: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema } as const

const taxIdParams = { type: "object", properties: { taxId: { type: "string" } } } as const

const idParams = { type: "object", properties: { id: { type: "string" } } } as const

type CompanyBody = {
  taxId?: string
  businessName?: string | null
  crmBrand?: string | null
  crmProduct?: string | null
  crmOrigin?: string | null
  originSource?: string | null
}

type ContactBody = {
  fullName?: string
  companyTaxIds?: string[]
  phone?: string | null
  email?: string | null
  birthday?: string | null
  cuil?: string | null
}

type TaskBody = {
  companyTaxId?: string
  description?: string
  dueDate?: string
  assignee?: string | null
  contactIds?: string[]
  status?: string
  cancelReason?: string | null
}

type ActionBody = {
  companyTaxId?: string
  date?: string
  description?: string
  contactIds?: string[]
  completesTaskIds?: string[]
  nextTask?: TaskBody | null
}

export default async function crmRoutes(server: FastifyInstance) {
  const repository = new Neo4jCrmRepository()
  const service = new CrmService(repository)
  const nosisPending = new NosisPendingService(repository)

  server.get(
    "/crm/companies",
    {
      schema: {
        summary: "The companies in the CRM",
        response: { 200: { type: "object", properties: { companies: { type: "array", items: companySchema } } } },
      },
    },
    async () => ({ companies: await service.listCompanies() })
  )

  server.post<{ Body: CompanyBody }>(
    "/crm/companies",
    {
      schema: {
        summary: "Add a company to the CRM",
        body: companyBodySchema,
        response: {
          201: {
            type: "object",
            properties: {
              taxId: { type: "string" },
              created: { type: "boolean" },
              restored: { type: "boolean" },
              nosisPending: { type: "boolean" },
            },
          },
          ...errors,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await service.addCompany(request.body ?? {}, request.username)
        logCrmOperation(request.username, "crm_add", "CrmCompany", result.taxId)
        return reply.code(201).send(result)
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.get<{ Params: { taxId: string } }>(
    "/crm/companies/:taxId",
    {
      schema: {
        summary: "A CRM company with its contacts, actions and tasks",
        params: taxIdParams,
        response: {
          200: {
            type: "object",
            properties: {
              company: companySchema,
              contacts: { type: "array", items: contactSchema },
              actions: { type: "array", items: actionSchema },
              tasks: { type: "array", items: taskSchema },
            },
          },
          ...errors,
        },
      },
    },
    async (request, reply) => {
      try {
        return await service.companyDetail(request.params.taxId)
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.patch<{ Params: { taxId: string }; Body: CompanyBody }>(
    "/crm/companies/:taxId",
    {
      schema: {
        summary: "Change the CRM data of a company",
        params: taxIdParams,
        body: companyBodySchema,
        response: { 200: companySchema, ...errors },
      },
    },
    async (request, reply) => {
      try {
        const company = await service.updateCompany(request.params.taxId, request.body ?? {}, request.username)
        logCrmOperation(request.username, "update", "CrmCompany", company.taxId)
        return company
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.delete<{ Params: { taxId: string }; Querystring: { dryRun?: string } }>(
    "/crm/companies/:taxId",
    {
      schema: {
        summary: "Take a company out of the CRM",
        description: "A company with CRM history is archived, never deleted. dryRun=true reports the outcome and writes nothing.",
        params: taxIdParams,
        querystring: { type: "object", properties: { dryRun: { type: "string" } } },
        response: {
          200: {
            type: "object",
            properties: { outcome: { type: "string" }, cancelledTaskCount: { type: "number" }, dryRun: { type: "boolean" } },
          },
          ...errors,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await service.removeCompany(request.params.taxId, request.query.dryRun === "true", request.username)
        if (!result.dryRun) logCrmOperation(request.username, `crm_remove_${result.outcome}`, "CrmCompany", request.params.taxId)
        return result
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.post<{ Params: { taxId: string }; Body: { reason?: string } }>(
    "/crm/companies/:taxId/close",
    {
      schema: {
        summary: "Close a company that no longer goes anywhere",
        description: "Cancels its open tasks with the reason. If the CUIT is in any source it gets the Inservible trust level with that reason.",
        params: taxIdParams,
        body: { type: "object", properties: { reason: { type: "string" } } },
        response: {
          200: {
            type: "object",
            properties: { company: companySchema, cancelledTaskCount: { type: "number" }, inservible: { type: "boolean" } },
          },
          ...errors,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await service.closeCompany(request.params.taxId, request.body?.reason, request.username)
        logCrmOperation(request.username, "close", "CrmCompany", request.params.taxId)
        return result
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.post<{ Params: { taxId: string } }>(
    "/crm/companies/:taxId/reopen",
    { schema: { summary: "Reopen a closed company", params: taxIdParams, response: { 200: companySchema, ...errors } } },
    async (request, reply) => {
      try {
        const company = await service.reopenCompany(request.params.taxId, request.username)
        logCrmOperation(request.username, "reopen", "CrmCompany", request.params.taxId)
        return company
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.get(
    "/crm/sources",
    {
      schema: {
        summary: "The sources a company's origin can point to",
        response: {
          200: {
            type: "object",
            properties: {
              sources: {
                type: "array",
                items: { type: "object", properties: { name: { type: "string" }, category: { type: "string" } } },
              },
            },
          },
        },
      },
    },
    async () => ({ sources: await service.listSources() })
  )

  server.post<{ Body: ContactBody }>(
    "/crm/contacts",
    {
      schema: { summary: "Add a contact", body: contactBodySchema, response: { 201: contactSchema, ...errors } },
    },
    async (request, reply) => {
      try {
        const contact = await service.createContact(request.body ?? {}, request.username)
        logCrmOperation(request.username, "create", "Contact", contact.id)
        return reply.code(201).send(contact)
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.patch<{ Params: { id: string }; Body: ContactBody }>(
    "/crm/contacts/:id",
    {
      schema: {
        summary: "Change a contact",
        params: idParams,
        body: contactBodySchema,
        response: { 200: contactSchema, ...errors },
      },
    },
    async (request, reply) => {
      try {
        const contact = await service.updateContact(request.params.id, request.body ?? {}, request.username)
        logCrmOperation(request.username, "update", "Contact", contact.id)
        return contact
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.delete<{ Params: { id: string } }>(
    "/crm/contacts/:id",
    { schema: { summary: "Archive a contact", params: idParams, response: { 200: contactSchema, ...errors } } },
    async (request, reply) => {
      try {
        const contact = await service.archiveContact(request.params.id, request.username)
        logCrmOperation(request.username, "archive", "Contact", contact.id)
        return contact
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.post<{ Params: { id: string } }>(
    "/crm/contacts/:id/restore",
    { schema: { summary: "Restore an archived contact", params: idParams, response: { 200: contactSchema, ...errors } } },
    async (request, reply) => {
      try {
        const contact = await service.restoreContact(request.params.id, request.username)
        logCrmOperation(request.username, "restore", "Contact", contact.id)
        return contact
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.get(
    "/crm/users",
    {
      schema: {
        summary: "The active users a task can be assigned to, with their color",
        response: {
          200: {
            type: "object",
            properties: {
              users: {
                type: "array",
                items: { type: "object", properties: { username: { type: "string" }, color: nullableString } },
              },
            },
          },
        },
      },
    },
    async () => ({ users: await service.listUsers() })
  )

  server.post<{ Body: ActionBody }>(
    "/crm/actions",
    {
      schema: {
        summary: "Record an action, close the tasks it fulfils and open the next one, in one transaction",
        body: actionBodySchema,
        response: {
          201: {
            type: "object",
            properties: {
              action: actionSchema,
              closedTasks: { type: "array", items: taskSchema },
              nextTask: { anyOf: [taskSchema, { type: "null" }] },
            },
          },
          ...errors,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await service.recordAction(request.body ?? {}, actorOf(request))
        logCrmOperation(request.username, "create", "Action", result.action.id)
        return reply.code(201).send(result)
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.patch<{ Params: { id: string }; Body: ActionBody }>(
    "/crm/actions/:id",
    {
      schema: { summary: "Change an action", params: idParams, body: actionBodySchema, response: { 200: actionSchema, ...errors } },
    },
    async (request, reply) => {
      try {
        const action = await service.updateAction(request.params.id, request.body ?? {}, actorOf(request))
        logCrmOperation(request.username, "update", "Action", action.id)
        return action
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.delete<{ Params: { id: string } }>(
    "/crm/actions/:id",
    { schema: { summary: "Archive an action", params: idParams, response: { 200: actionSchema, ...errors } } },
    async (request, reply) => {
      try {
        const action = await service.archiveAction(request.params.id, actorOf(request))
        logCrmOperation(request.username, "archive", "Action", action.id)
        return action
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.post<{ Params: { id: string } }>(
    "/crm/actions/:id/restore",
    { schema: { summary: "Restore an archived action", params: idParams, response: { 200: actionSchema, ...errors } } },
    async (request, reply) => {
      try {
        const action = await service.restoreAction(request.params.id, actorOf(request))
        logCrmOperation(request.username, "restore", "Action", action.id)
        return action
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.post<{ Body: TaskBody }>(
    "/crm/tasks",
    {
      schema: {
        summary: "Add a task to a company",
        body: { type: "object", properties: taskBodyProperties },
        response: { 201: taskSchema, ...errors },
      },
    },
    async (request, reply) => {
      try {
        const task = await service.createTask(request.body ?? {}, actorOf(request))
        logCrmOperation(request.username, "create", "Task", task.id)
        return reply.code(201).send(task)
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.patch<{ Params: { id: string }; Body: TaskBody }>(
    "/crm/tasks/:id",
    {
      schema: {
        summary: "Change, reassign, complete or cancel a task",
        params: idParams,
        body: { type: "object", properties: taskBodyProperties },
        response: { 200: taskSchema, ...errors },
      },
    },
    async (request, reply) => {
      try {
        const task = await service.updateTask(request.params.id, request.body ?? {}, actorOf(request))
        logCrmOperation(request.username, task.status === "open" ? "update" : task.status, "Task", task.id)
        return task
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.delete<{ Params: { id: string } }>(
    "/crm/tasks/:id",
    { schema: { summary: "Archive a task", params: idParams, response: { 200: taskSchema, ...errors } } },
    async (request, reply) => {
      try {
        const task = await service.archiveTask(request.params.id, actorOf(request))
        logCrmOperation(request.username, "archive", "Task", task.id)
        return task
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.post<{ Params: { id: string } }>(
    "/crm/tasks/:id/restore",
    { schema: { summary: "Restore an archived task", params: idParams, response: { 200: taskSchema, ...errors } } },
    async (request, reply) => {
      try {
        const task = await service.restoreTask(request.params.id, actorOf(request))
        logCrmOperation(request.username, "restore", "Task", task.id)
        return task
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.get<{ Querystring: AgendaQuery }>(
    "/crm/agenda",
    {
      schema: {
        summary: "Open tasks by due date",
        description: "assignee is me (default), all or a username. Overdue is computed in Buenos Aires time.",
        querystring: { type: "object", properties: { assignee: { type: "string" }, overdueOnly: { type: "string" } } },
        response: { 200: { type: "object", properties: { tasks: { type: "array", items: agendaItemSchema } } } },
      },
    },
    async (request) => ({ tasks: await service.agenda(request.query, actorOf(request)) })
  )

  server.get(
    "/crm/nosis-pending",
    {
      preHandler: requireCreator,
      schema: {
        hide: true,
        response: {
          200: {
            type: "object",
            properties: {
              command: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    taxId: { type: "string" },
                    businessName: { type: "string" },
                    sources: { type: "array", items: { type: "string" } },
                    addedBy: nullableString,
                    addedAt: nullableString,
                  },
                },
              },
            },
          },
          403: errorSchema,
        },
      },
    },
    async () => ({ command: NOSIS_PENDING_COMMAND, items: await nosisPending.list() })
  )

  server.get<{ Querystring: { entityType?: string; entityId?: string } }>(
    "/crm/changes",
    {
      schema: {
        summary: "The change history of one CRM entity",
        querystring: { type: "object", properties: { entityType: { type: "string" }, entityId: { type: "string" } } },
        response: { 200: { type: "object", properties: { changes: { type: "array", items: changeSchema } } }, ...errors },
      },
    },
    async (request, reply) => {
      try {
        return { changes: await service.changes(request.query.entityType, request.query.entityId) }
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )
}
