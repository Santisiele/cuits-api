import type { FastifyInstance } from "fastify"
import type { AgendaQuery } from "@application/CrmServiceBase.js"
import { CrmCompanyService } from "@application/CrmCompanyService.js"
import { CrmContactService } from "@application/CrmContactService.js"
import { CrmWorkService } from "@application/CrmWorkService.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { NosisPendingService } from "@application/NosisPendingService.js"
import { requireCreator } from "@middleware/requireCreator.js"
import { logCrmOperation } from "@auth/activityLogger.js"
import { NOSIS_PENDING_COMMAND } from "@domain/nosisPending.js"
import responsibleRoutes from "@routes/responsibles.js"
import { actionDetails, taskDetails, actorOf, handleError } from "@routes/crmHttp.js"
import {
  nullableString,
  companySchema,
  contactSchema,
  actionSchema,
  taskSchema,
  agendaItemSchema,
  changeSchema,
  taskBodyProperties,
  actionBodySchema,
  companyBodySchema,
  contactBodySchema,
  errorSchema,
  errors,
  taxIdParams,
  idParams,
  type CompanyBody,
  type ContactBody,
  type TaskBody,
  type ActionBody,
} from "@routes/crmSchemas.js"

export default async function crmRoutes(server: FastifyInstance) {
  const repository = new Neo4jCrmRepository()
  const companies = new CrmCompanyService(repository)
  const contacts = new CrmContactService(repository)
  const work = new CrmWorkService(repository)
  const nosisPending = new NosisPendingService(repository)

  await server.register(responsibleRoutes)

  server.get(
    "/crm/companies",
    {
      schema: {
        summary: "The companies in the CRM",
        response: { 200: { type: "object", properties: { companies: { type: "array", items: companySchema } } } },
      },
    },
    async () => ({ companies: await companies.listCompanies() })
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
        const result = await companies.addCompany(request.body ?? {}, request.username)
        logCrmOperation(request.username, "crm_add", "CrmCompany", result.taxId, { businessName: request.body?.businessName ?? null, originSource: request.body?.originSource ?? null })
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
        return await companies.companyDetail(request.params.taxId)
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
        const company = await companies.updateCompany(request.params.taxId, request.body ?? {}, request.username)
        logCrmOperation(request.username, "update", "CrmCompany", company.taxId, { businessName: company.businessName })
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
        const result = await companies.removeCompany(request.params.taxId, request.query.dryRun === "true", request.username)
        if (!result.dryRun) logCrmOperation(request.username, "crm_remove", "CrmCompany", request.params.taxId, { outcome: result.outcome })
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
        const result = await companies.closeCompany(request.params.taxId, request.body?.reason, request.username)
        logCrmOperation(request.username, "close", "CrmCompany", request.params.taxId, { businessName: result.company.businessName, reason: result.company.closedReason, inservible: result.inservible })
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
        const company = await companies.reopenCompany(request.params.taxId, request.username)
        logCrmOperation(request.username, "reopen", "CrmCompany", request.params.taxId, { businessName: company.businessName })
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
    async () => ({ sources: await companies.listSources() })
  )

  server.post<{ Body: ContactBody }>(
    "/crm/contacts",
    {
      schema: { summary: "Add a contact", body: contactBodySchema, response: { 201: contactSchema, ...errors } },
    },
    async (request, reply) => {
      try {
        const contact = await contacts.createContact(request.body ?? {}, request.username)
        logCrmOperation(request.username, "create", "Contact", contact.id, { fullName: contact.fullName, companyTaxIds: contact.companyTaxIds })
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
        const contact = await contacts.updateContact(request.params.id, request.body ?? {}, request.username)
        logCrmOperation(request.username, "update", "Contact", contact.id, { fullName: contact.fullName, companyTaxIds: contact.companyTaxIds })
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
        const contact = await contacts.archiveContact(request.params.id, request.username)
        logCrmOperation(request.username, "archive", "Contact", contact.id, { fullName: contact.fullName, companyTaxIds: contact.companyTaxIds })
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
        const contact = await contacts.restoreContact(request.params.id, request.username)
        logCrmOperation(request.username, "restore", "Contact", contact.id, { fullName: contact.fullName, companyTaxIds: contact.companyTaxIds })
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
    async () => ({ users: await companies.listUsers() })
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
        const result = await work.recordAction(request.body ?? {}, actorOf(request))
        logCrmOperation(request.username, "create", "Action", result.action.id, { ...actionDetails(result.action), nextTask: result.nextTask?.description ?? null, nextAssignee: result.nextTask?.assignee ?? null, nextDueDate: result.nextTask?.dueDate ?? null })
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
        const action = await work.updateAction(request.params.id, request.body ?? {}, actorOf(request))
        logCrmOperation(request.username, "update", "Action", action.id, actionDetails(action))
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
        const action = await work.archiveAction(request.params.id, actorOf(request))
        logCrmOperation(request.username, "archive", "Action", action.id, actionDetails(action))
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
        const action = await work.restoreAction(request.params.id, actorOf(request))
        logCrmOperation(request.username, "restore", "Action", action.id, actionDetails(action))
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
        const task = await work.createTask(request.body ?? {}, actorOf(request))
        logCrmOperation(request.username, "create", "Task", task.id, taskDetails(task))
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
        const task = await work.updateTask(request.params.id, request.body ?? {}, actorOf(request))
        logCrmOperation(request.username, task.status === "open" ? "update" : task.status === "done" ? "complete" : "cancel", "Task", task.id, taskDetails(task))
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
        const task = await work.archiveTask(request.params.id, actorOf(request))
        logCrmOperation(request.username, "archive", "Task", task.id, taskDetails(task))
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
        const task = await work.restoreTask(request.params.id, actorOf(request))
        logCrmOperation(request.username, "restore", "Task", task.id, taskDetails(task))
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
    async (request) => ({ tasks: await work.agenda(request.query, actorOf(request)) })
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
        return { changes: await companies.changes(request.query.entityType, request.query.entityId) }
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )
}
