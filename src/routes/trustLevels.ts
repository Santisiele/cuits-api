import type { FastifyInstance, FastifyReply } from "fastify"
import { TrustLevelAdminService, TrustLevelAdminError } from "@application/TrustLevelAdminService.js"
import { Neo4jSource } from "@infrastructure/neo4j/Neo4jSource.js"
import { verifyUserPassword, PasswordVerificationError } from "@auth/passwordVerifier.js"
import { logTrustLevelsViewed, logTrustLevelOperation } from "@auth/activityLogger.js"
import { TRUST_LEVEL_COLORS } from "@domain/entities.js"
import type { TrustLevelRejection } from "@domain/entities.js"

const neo4jSource = new Neo4jSource()
const adminService = new TrustLevelAdminService(neo4jSource.getRepository())

const STATUS_BY_REASON: Record<TrustLevelRejection, number> = {
  level_not_found: 404,
  label_conflict: 409,
  invalid_color: 400,
  invalid_label: 400,
  reserved_level: 400,
}

function handleTrustLevelError(err: TrustLevelAdminError, reply: FastifyReply) {
  const status = STATUS_BY_REASON[err.reason] ?? 500
  return reply.code(status).send({ error: err.reason, message: err.message })
}

async function requirePassword(
  username: string,
  password: string | undefined,
  reply: FastifyReply
): Promise<boolean> {
  if (!password) {
    await reply.code(400).send({ message: "Password required for this operation" })
    return false
  }
  try {
    await verifyUserPassword(username, password)
    return true
  } catch (err) {
    if (err instanceof PasswordVerificationError) {
      await reply.code(401).send({ message: "Invalid password" })
      return false
    }
    throw err
  }
}

const summarySchema = {
  type: "object",
  properties: {
    operation: { type: "string" },
    value: { type: "number" },
    label: { type: "string" },
    affectedNodeCount: { type: "number" },
    dryRun: { type: "boolean" },
    message: { type: "string" },
  },
} as const

const conflictSchema = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
} as const

export default async function trustLevelRoutes(server: FastifyInstance) {
  server.get(
    "/trust-levels",
    {
      schema: {
        summary: "List the trust levels",
        description:
          "Level 0 is not listed: it stands for a CUIT with no level assigned " +
          "and cannot be managed.",
        response: {
          200: {
            type: "object",
            properties: {
              levels: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: { type: "number" },
                    label: { type: "string" },
                    color: { type: "string" },
                    description: { type: "string" },
                    nodeCount: { type: "number" },
                  },
                },
              },
              colors: { type: "array", items: { type: "string" } },
            },
          },
          401: { $ref: "UnauthorizedResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      try {
        const levels = await adminService.listLevels()
        logTrustLevelsViewed(request.username, levels.length)
        return { levels, colors: TRUST_LEVEL_COLORS }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  server.post<{
    Querystring: { dryRun?: string }
    Body: { label: string; color: string; password?: string, description: string | null }
  }>(
    "/trust-levels",
    {
      schema: {
        summary: "Create a trust level",
        querystring: { type: "object", properties: { dryRun: { type: "string" } } },
        body: {
          type: "object",
          required: ["label", "color"],
          properties: {
            label: { type: "string" },
            color: { type: "string" },
            password: { type: "string" },
            description: { type: "string" },
          },
        },
        response: {
          200: summarySchema,
          400: conflictSchema,
          401: { $ref: "UnauthorizedResponse" },
          409: conflictSchema,
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const { label, color, password, description } = request.body
      const dryRun = request.query.dryRun === "true"

      if (!dryRun && !(await requirePassword(request.username, password, reply))) return

      try {
        const summary = await adminService.createLevel(label, color, dryRun, description)
        if (!dryRun) logTrustLevelOperation(request.username, summary)
        return summary
      } catch (err) {
        if (err instanceof TrustLevelAdminError) return handleTrustLevelError(err, reply)
        request.log.error(err)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  server.patch<{
    Params: { value: string }
    Querystring: { dryRun?: string }
    Body: { label?: string; color?: string; password?: string, description: string | null }
  }>(
    "/trust-levels/:value",
    {
      schema: {
        summary: "Rename a trust level or change its color",
        params: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
        querystring: { type: "object", properties: { dryRun: { type: "string" } } },
        body: {
          type: "object",
          properties: {
            label: { type: "string" },
            color: { type: "string" },
            password: { type: "string" },
            description: { type: "string" },
          },
        },
        response: {
          200: summarySchema,
          400: conflictSchema,
          401: { $ref: "UnauthorizedResponse" },
          404: { $ref: "NotFoundResponse" },
          409: conflictSchema,
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const value = Number(request.params.value)
      const { label, color, password, description } = request.body
      const dryRun = request.query.dryRun === "true"

      if (!Number.isInteger(value)) {
        return reply.code(400).send({ message: "The level must be a whole number" })
      }
      if (!dryRun && !(await requirePassword(request.username, password, reply))) return

      try {
        const summary = await adminService.updateLevel(value, label, color, dryRun, description)
        if (!dryRun) logTrustLevelOperation(request.username, summary)
        return summary
      } catch (err) {
        if (err instanceof TrustLevelAdminError) return handleTrustLevelError(err, reply)
        request.log.error(err)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  server.delete<{
    Params: { value: string }
    Querystring: { dryRun?: string }
    Body: { password?: string }
  }>(
    "/trust-levels/:value",
    {
      schema: {
        summary: "Delete a trust level and move its CUITs back to no level",
        params: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
        querystring: { type: "object", properties: { dryRun: { type: "string" } } },
        body: { type: "object", properties: { password: { type: "string" } } },
        response: {
          200: summarySchema,
          400: conflictSchema,
          401: { $ref: "UnauthorizedResponse" },
          404: { $ref: "NotFoundResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const value = Number(request.params.value)
      const dryRun = request.query.dryRun === "true"

      if (!Number.isInteger(value)) {
        return reply.code(400).send({ message: "The level must be a whole number" })
      }
      if (!dryRun && !(await requirePassword(request.username, request.body?.password, reply))) return

      try {
        const summary = await adminService.deleteLevel(value, dryRun)
        if (!dryRun) logTrustLevelOperation(request.username, summary)
        return summary
      } catch (err) {
        if (err instanceof TrustLevelAdminError) return handleTrustLevelError(err, reply)
        request.log.error(err)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )
}
