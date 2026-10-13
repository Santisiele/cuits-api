import type { FastifyRequest, FastifyReply } from "fastify"
import { logForbidden } from "@auth/activityLogger.js"
import { canAdminister } from "@domain/users.js"

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (canAdminister(request.role)) return
  logForbidden(request.username, request.ip, request.url)
  await reply.code(403).send({ error: "forbidden", message: "Only an admin can do this" })
}
