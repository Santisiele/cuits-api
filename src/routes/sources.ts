import type { FastifyInstance, FastifyReply } from "fastify"
import { SourceAdminService, SourceAdminError } from "@application/SourceAdminService.js"
import { Neo4jSource } from "@infrastructure/neo4j/Neo4jSource.js"
import { verifyUserPassword, PasswordVerificationError } from "@auth/passwordVerifier.js"
import type { SourceAdminRejection } from "@domain/entities.js"

const neo4jSource = new Neo4jSource()
const adminService = new SourceAdminService(neo4jSource.getRepository())

// ─── Error mapping ────────────────────────────────────────────────────────────

const STATUS_BY_REASON: Record<SourceAdminRejection, number> = {
  source_not_found: 404,
  node_not_found: 404,
  name_conflict: 409,
  category_mismatch: 409,
  invalid_move_params: 400,
}

function handleSourceAdminError(err: SourceAdminError, reply: FastifyReply) {
  const status = STATUS_BY_REASON[err.reason] ?? 500
  return reply.code(status).send({ error: err.reason, message: err.message })
}

/**
 * Step-up authentication: a valid JWT is not enough to run a destructive
 * operation, the caller has to re-enter their password.
 *
 * Returns false after having already sent the error response, so handlers
 * only need to bail out.
 */
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

// ─── Shared response schema ───────────────────────────────────────────────────

const operationSummarySchema = {
  type: "object",
  properties: {
    operation: { type: "string" },
    affectedNodeCount: { type: "number" },
    removedNodeCount: { type: "number" },
    updatedNodeCount: { type: "number" },
    createdSourceName: { type: "string" },
    removedSourceName: { type: "string" },
    dryRun: { type: "boolean" },
    message: { type: "string" },
  },
} as const

const conflictSchema = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
} as const

/**
 * Source administration routes.
 *
 * Every destructive endpoint accepts `?dryRun=true`, which returns the same
 * summary shape with the counters filled in but writes nothing. A dry run
 * skips password verification because it has no side effects.
 */
export default async function sourceAdminRoutes(server: FastifyInstance) {
  // ─── GET /sources ─────────────────────────────────────────────────────────

  server.get(
    "/sources",
    {
      schema: {
        summary: "List every source with its category and node count",
        response: {
          200: {
            type: "object",
            properties: {
              sources: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    category: { type: "string" },
                    nodeCount: { type: "number" },
                  },
                },
              },
            },
          },
          401: { $ref: "UnauthorizedResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      try {
        const sources = await neo4jSource.findSources()
        return { sources }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── PATCH /sources/:name ─────────────────────────────────────────────────

  server.patch<{
    Params: { name: string }
    Querystring: { dryRun?: string }
    Body: { newName: string; password?: string }
  }>(
    "/sources/:name",
    {
      schema: {
        summary: "Rename a source",
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { dryRun: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["newName"],
          properties: {
            newName: { type: "string" },
            password: { type: "string" },
          },
        },
        response: {
          200: operationSummarySchema,
          400: { $ref: "BadResponse" },
          401: { $ref: "UnauthorizedResponse" },
          404: { $ref: "NotFoundResponse" },
          409: conflictSchema,
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const { name } = request.params
      const { newName, password } = request.body
      const dryRun = request.query.dryRun === "true"

      if (!dryRun && !(await requirePassword(request.username, password, reply))) return

      try {
        return await adminService.renameSource(name, newName, request.username, dryRun)
      } catch (err) {
        if (err instanceof SourceAdminError) return handleSourceAdminError(err, reply)
        request.log.error(err)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── POST /sources/merge ──────────────────────────────────────────────────

  server.post<{
    Querystring: { dryRun?: string }
    Body: { sourceToKeep: string; sourceToDrop: string; password?: string }
  }>(
    "/sources/merge",
    {
      schema: {
        summary: "Merge one source into another",
        querystring: {
          type: "object",
          properties: { dryRun: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["sourceToKeep", "sourceToDrop"],
          properties: {
            sourceToKeep: { type: "string" },
            sourceToDrop: { type: "string" },
            password: { type: "string" },
          },
        },
        response: {
          200: operationSummarySchema,
          400: { $ref: "BadResponse" },
          401: { $ref: "UnauthorizedResponse" },
          404: { $ref: "NotFoundResponse" },
          409: conflictSchema,
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const { sourceToKeep, sourceToDrop, password } = request.body
      const dryRun = request.query.dryRun === "true"

      if (!dryRun && !(await requirePassword(request.username, password, reply))) return

      try {
        return await adminService.mergeSources(
          sourceToKeep,
          sourceToDrop,
          request.username,
          dryRun
        )
      } catch (err) {
        if (err instanceof SourceAdminError) return handleSourceAdminError(err, reply)
        request.log.error(err)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── DELETE /sources/:name ────────────────────────────────────────────────

  server.delete<{
    Params: { name: string }
    Querystring: { dryRun?: string }
    Body: { password?: string }
  }>(
    "/sources/:name",
    {
      schema: {
        summary: "Delete a source, removing nodes left without any",
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { dryRun: { type: "string" } },
        },
        body: {
          type: "object",
          properties: { password: { type: "string" } },
        },
        response: {
          200: operationSummarySchema,
          400: { $ref: "BadResponse" },
          401: { $ref: "UnauthorizedResponse" },
          404: { $ref: "NotFoundResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const { name } = request.params
      const { password } = request.body ?? {}
      const dryRun = request.query.dryRun === "true"

      if (!dryRun && !(await requirePassword(request.username, password, reply))) return

      try {
        return await adminService.deleteSource(name, request.username, dryRun)
      } catch (err) {
        if (err instanceof SourceAdminError) return handleSourceAdminError(err, reply)
        request.log.error(err)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── POST /nodes/:taxId/sources ───────────────────────────────────────────

  server.post<{
    Params: { taxId: string }
    Querystring: { dryRun?: string }
    Body: {
      sourceName: string
      mode: "add" | "move"
      fromSource?: string
      password?: string
    }
  }>(
    "/nodes/:taxId/sources",
    {
      schema: {
        summary: "Add a source to a node, or move it between sources",
        params: {
          type: "object",
          required: ["taxId"],
          properties: { taxId: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { dryRun: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["sourceName", "mode"],
          properties: {
            sourceName: { type: "string" },
            mode: { type: "string", enum: ["add", "move"] },
            fromSource: { type: "string" },
            password: { type: "string" },
          },
        },
        response: {
          200: operationSummarySchema,
          400: { $ref: "BadResponse" },
          401: { $ref: "UnauthorizedResponse" },
          404: { $ref: "NotFoundResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const { taxId } = request.params
      const { sourceName, mode, fromSource, password } = request.body
      const dryRun = request.query.dryRun === "true"

      if (mode === "move" && !fromSource) {
        return reply.code(400).send({ message: "fromSource is required in move mode" })
      }

      if (!dryRun && !(await requirePassword(request.username, password, reply))) return

      try {
        if (mode === "add") {
          return await adminService.addSourceToNode(
            taxId,
            sourceName,
            request.username,
            dryRun
          )
        }
        return await adminService.moveSourceOnNode(
          taxId,
          fromSource as string,
          sourceName,
          request.username,
          dryRun
        )
      } catch (err) {
        if (err instanceof SourceAdminError) return handleSourceAdminError(err, reply)
        request.log.error(err)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )
}
