import type { FastifyInstance, FastifyReply } from "fastify"
import { UserAdminService, UserAdminError } from "@application/UserAdminService.js"
import { Neo4jUserRepository } from "@infrastructure/neo4j/Neo4jUserRepository.js"
import { BcryptPasswordHasher } from "@infrastructure/auth/BcryptPasswordHasher.js"
import { requireAdmin } from "@middleware/requireAdmin.js"
import { logUserOperation } from "@auth/activityLogger.js"
import type { UserRejection } from "@domain/users.js"

const service = new UserAdminService(new Neo4jUserRepository(), new BcryptPasswordHasher())

const STATUS_BY_REASON: Record<UserRejection, number> = {
  invalid_username: 400,
  invalid_password: 400,
  invalid_role: 400,
  invalid_disabled: 400,
  wrong_password: 400,
  creator_only: 403,
  user_not_found: 404,
  username_taken: 409,
  cannot_change_creator: 409,
}

function handleError(err: unknown, reply: FastifyReply) {
  if (!(err instanceof UserAdminError)) throw err
  return reply.code(STATUS_BY_REASON[err.reason]).send({ error: err.reason, message: err.message })
}

const userSchema = {
  type: "object",
  properties: {
    username: { type: "string" },
    role: { type: "string" },
    createdAt: { type: "string" },
    disabled: { type: "boolean" },
  },
} as const

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
} as const

const messageSchema = {
  type: "object",
  properties: { message: { type: "string" } },
} as const

export default async function userRoutes(server: FastifyInstance) {
  server.get(
    "/auth/me",
    {
      schema: {
        summary: "The logged-in user and their role",
        response: {
          200: {
            type: "object",
            properties: { username: { type: "string" }, role: { type: "string" } },
          },
        },
      },
    },
    async (request) => ({ username: request.username, role: request.role })
  )

  server.patch<{ Body: { currentPassword: string; newPassword: string } }>(
    "/auth/password",
    {
      schema: {
        summary: "Change your own password",
        body: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          properties: {
            currentPassword: { type: "string" },
            newPassword: { type: "string" },
          },
        },
        response: { 200: messageSchema, 400: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      try {
        await service.changeOwnPassword(request.username, request.body.currentPassword, request.body.newPassword)
        logUserOperation(request.username, "change_own_password", request.username)
        return { message: "Password changed" }
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.get(
    "/users",
    {
      preHandler: requireAdmin,
      schema: {
        summary: "List the users (admin only)",
        response: {
          200: { type: "object", properties: { users: { type: "array", items: userSchema } } },
          403: errorSchema,
        },
      },
    },
    async () => ({ users: await service.list() })
  )

  server.post<{ Body: { username: string; password: string; role: string } }>(
    "/users",
    {
      preHandler: requireAdmin,
      schema: {
        summary: "Create a user (admin only)",
        body: {
          type: "object",
          required: ["username", "password", "role"],
          properties: {
            username: { type: "string" },
            password: { type: "string" },
            role: { type: "string" },
          },
        },
        response: { 201: userSchema, 400: errorSchema, 403: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      try {
        const user = await service.create(request.body.username, request.body.password, request.body.role)
        logUserOperation(request.username, "create", user.username, { role: user.role })
        return reply.code(201).send(user)
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.patch<{ Params: { username: string }; Body: { role?: string; disabled?: boolean } }>(
    "/users/:username",
    {
      preHandler: requireAdmin,
      schema: {
        summary: "Change a user's role or disable / enable them (admin only)",
        description: "Users are never deleted, because actions and tasks point at them.",
        params: { type: "object", properties: { username: { type: "string" } } },
        body: {
          type: "object",
          properties: {
            role: { type: "string" },
            disabled: { type: "boolean" },
          },
        },
        response: { 200: userSchema, 400: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      try {
        const user = await service.update(request.role, request.params.username, request.body)
        logUserOperation(request.username, "update", user.username, { ...request.body })
        return user
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.post<{ Params: { username: string }; Body: { password: string } }>(
    "/users/:username/password",
    {
      preHandler: requireAdmin,
      schema: {
        summary: "Reset a user's password (admin only)",
        params: { type: "object", properties: { username: { type: "string" } } },
        body: {
          type: "object",
          required: ["password"],
          properties: { password: { type: "string" } },
        },
        response: { 200: messageSchema, 400: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema },
      },
    },
    async (request, reply) => {
      try {
        await service.resetPassword(request.role, request.params.username, request.body.password)
        logUserOperation(request.username, "reset_password", request.params.username)
        return { message: "Password reset" }
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )
}
