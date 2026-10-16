import type { FastifyInstance, FastifyReply } from "fastify"
import { WebResearchService, WebResearchError } from "@application/WebResearchService.js"
import { Neo4jWebResearchRepository } from "@infrastructure/neo4j/Neo4jWebResearchRepository.js"
import { ClaudeWebResearcher } from "@infrastructure/anthropic/ClaudeWebResearcher.js"
import { requireAdmin } from "@middleware/requireAdmin.js"
import { requireCreator } from "@middleware/requireCreator.js"
import { logResearchArchived, logResearchBudgetChanged, logResearchRestored, logWebResearch } from "@auth/activityLogger.js"
import { config } from "@config.js"
import type { WebResearchRejection } from "@domain/webResearch.js"

const STATUS_BY_REASON: Record<WebResearchRejection, number> = {
  invalid_cuit: 400,
  invalid_limit: 400,
  cuit_not_found: 404,
  budget_exhausted: 409,
  research_failed: 502,
  research_off: 503,
  research_not_found: 404,
  already_archived: 409,
  not_archived: 409,
}

function handleError(err: unknown, reply: FastifyReply) {
  if (!(err instanceof WebResearchError)) throw err
  return reply.code(STATUS_BY_REASON[err.reason]).send({ error: err.reason, message: err.message })
}

const researchProperties = {
  id: { type: "string" },
  taxId: { type: "string" },
  requestedAt: { type: "string" },
  requestedBy: { type: "string" },
  status: { type: "string" },
  summary: { type: "string" },
  sources: {
    type: "array",
    items: { type: "object", properties: { url: { type: "string" }, title: { type: "string" } } },
  },
  model: { type: "string" },
  costUsd: { type: "number" },
  webSearches: { type: "number" },
  archivedAt: { type: ["string", "null"] },
  archivedBy: { type: ["string", "null"] },
} as const

const researchSchema = { type: "object", properties: researchProperties } as const

const recentResearchSchema = {
  type: "object",
  properties: { ...researchProperties, businessName: { type: "string" } },
} as const

const budgetSchema = {
  type: "object",
  properties: {
    monthlyLimitUsd: { type: "number" },
    spentThisMonthUsd: { type: "number" },
    researchCountThisMonth: { type: "number" },
  },
} as const

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
} as const

const taxIdParams = { type: "object", properties: { taxId: { type: "string" } } } as const

const idParams = { type: "object", properties: { id: { type: "string" } } } as const

const changeSchema = {
  hide: true,
  params: idParams,
  response: { 200: researchSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema },
} as const

export default async function researchRoutes(server: FastifyInstance) {
  const apiKey = config.anthropic.apiKey
  const service = new WebResearchService(
    new Neo4jWebResearchRepository(),
    apiKey ? ClaudeWebResearcher.withApiKey(apiKey) : null
  )

  server.get(
    "/research/budget",
    {
      preHandler: requireAdmin,
      schema: { hide: true, response: { 200: budgetSchema, 403: errorSchema } },
    },
    async () => service.budget()
  )

  server.patch<{ Body: { monthlyLimitUsd?: unknown } | undefined }>(
    "/research/budget",
    {
      preHandler: requireCreator,
      schema: { hide: true, response: { 200: budgetSchema, 400: errorSchema, 403: errorSchema } },
    },
    async (request, reply) => {
      try {
        const budget = await service.setMonthlyLimit(request.body?.monthlyLimitUsd, request.username)
        logResearchBudgetChanged(request.username, budget.monthlyLimitUsd)
        return budget
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.get(
    "/research/recent",
    {
      preHandler: requireAdmin,
      schema: {
        hide: true,
        response: {
          200: { type: "object", properties: { research: { type: "array", items: recentResearchSchema } } },
          403: errorSchema,
        },
      },
    },
    async () => ({ research: await service.recent() })
  )

  server.get(
    "/research/archived",
    {
      preHandler: requireCreator,
      schema: {
        hide: true,
        response: {
          200: { type: "object", properties: { research: { type: "array", items: recentResearchSchema } } },
          403: errorSchema,
        },
      },
    },
    async () => ({ research: await service.archived() })
  )

  server.post<{ Params: { id: string } }>(
    "/research/:id/archive",
    { preHandler: requireAdmin, schema: changeSchema },
    async (request, reply) => {
      try {
        const research = await service.archive(request.params.id, request.username)
        logResearchArchived(request.username, research)
        return research
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.post<{ Params: { id: string } }>(
    "/research/:id/restore",
    { preHandler: requireCreator, schema: changeSchema },
    async (request, reply) => {
      try {
        const research = await service.restore(request.params.id)
        logResearchRestored(request.username, research)
        return research
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.get<{ Params: { taxId: string } }>(
    "/research/:taxId",
    {
      preHandler: requireAdmin,
      schema: {
        hide: true,
        params: taxIdParams,
        response: {
          200: { type: "object", properties: { research: { type: "array", items: researchSchema } } },
          400: errorSchema,
          403: errorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return { research: await service.history(request.params.taxId) }
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.post<{ Params: { taxId: string } }>(
    "/research/:taxId",
    {
      preHandler: requireAdmin,
      schema: {
        hide: true,
        params: taxIdParams,
        response: {
          201: researchSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          502: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const research = await service.research(request.params.taxId, request.username)
        logWebResearch(request.username, research)
        return reply.code(201).send(research)
      } catch (err) {
        if (err instanceof WebResearchError && err.research) {
          logWebResearch(request.username, err.research, err.detail)
        }
        return handleError(err, reply)
      }
    }
  )
}
