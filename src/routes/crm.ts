import type { FastifyInstance, FastifyReply } from "fastify"
import { CrmService, CrmError } from "@application/CrmService.js"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { logCrmOperation } from "@auth/activityLogger.js"
import type { CrmRejection } from "@domain/crm.js"

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
    nosisPending: { type: "boolean" },
    addedAt: nullableString,
    addedBy: nullableString,
    lastActionDate: nullableString,
    nextDueDate: nullableString,
    openTaskCount: { type: "number" },
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

const companyBodySchema = {
  type: "object",
  properties: {
    taxId: { type: "string" },
    businessName: nullableString,
    crmBrand: nullableString,
    crmProduct: nullableString,
    crmOrigin: nullableString,
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

const errors = { 400: errorSchema, 404: errorSchema, 409: errorSchema } as const

const taxIdParams = { type: "object", properties: { taxId: { type: "string" } } } as const

const idParams = { type: "object", properties: { id: { type: "string" } } } as const

type CompanyBody = { taxId?: string; businessName?: string | null; crmBrand?: string | null; crmProduct?: string | null; crmOrigin?: string | null }

type ContactBody = {
  fullName?: string
  companyTaxIds?: string[]
  phone?: string | null
  email?: string | null
  birthday?: string | null
  cuil?: string | null
}

export default async function crmRoutes(server: FastifyInstance) {
  const service = new CrmService(new Neo4jCrmRepository())

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
        summary: "A CRM company with its contacts",
        params: taxIdParams,
        response: {
          200: {
            type: "object",
            properties: { company: companySchema, contacts: { type: "array", items: contactSchema } },
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
          200: { type: "object", properties: { outcome: { type: "string" }, dryRun: { type: "boolean" } } },
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
}
