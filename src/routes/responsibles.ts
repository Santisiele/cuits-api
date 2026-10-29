import type { FastifyInstance } from "fastify"
import { Neo4jCrmRepository } from "@infrastructure/neo4j/Neo4jCrmRepository.js"
import { requireAdmin } from "@middleware/requireAdmin.js"
import { ResponsibleService } from "@application/ResponsibleService.js"
import { logCrmOperation } from "@auth/activityLogger.js"
import { handleError } from "@routes/crmHttp.js"
import { errors } from "@routes/crmSchemas.js"

const responsibleSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    color: { type: "string" },
    users: { type: "array", items: { type: "string" } },
    disabled: { type: "boolean" },
  },
} as const

const responsibleBody = {
  type: "object",
  properties: {
    name: { type: "string" },
    color: { type: "string" },
    users: { type: "array", items: { type: "string" } },
    disabled: { type: "boolean" },
  },
} as const

export default async function responsibleRoutes(server: FastifyInstance) {
  const responsibles = new ResponsibleService(new Neo4jCrmRepository())

  server.get(
    "/crm/responsibles",
    {
      schema: {
        summary: "Who actions and tasks can be attributed to, each with a color and the app users it stands for",
        response: { 200: { type: "object", properties: { responsibles: { type: "array", items: responsibleSchema } } } },
      },
    },
    async () => ({ responsibles: await responsibles.list() })
  )

  server.post<{ Body: { name?: string; color?: string; users?: string[] } }>(
    "/crm/responsibles",
    {
      preHandler: requireAdmin,
      schema: { summary: "Add a responsible (admin only)", body: responsibleBody, response: { 201: responsibleSchema, ...errors } },
    },
    async (request, reply) => {
      try {
        const responsible = await responsibles.create(request.body ?? {}, request.username)
        logCrmOperation(request.username, "create", "Responsible", responsible.name, { color: responsible.color, users: responsible.users })
        return reply.code(201).send(responsible)
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.patch<{ Params: { name: string }; Body: { name?: string; color?: string; users?: string[]; disabled?: boolean } }>(
    "/crm/responsibles/:name",
    {
      preHandler: requireAdmin,
      schema: {
        summary: "Rename, recolor, relink or disable a responsible (admin only)",
        params: { type: "object", properties: { name: { type: "string" } } },
        body: responsibleBody,
        response: { 200: responsibleSchema, ...errors },
      },
    },
    async (request, reply) => {
      try {
        const responsible = await responsibles.update(request.params.name, request.body ?? {}, request.username)
        logCrmOperation(request.username, "update", "Responsible", responsible.name, {
          previousName: request.params.name,
          color: responsible.color,
          users: responsible.users,
          disabled: responsible.disabled,
        })
        return responsible
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )
}
