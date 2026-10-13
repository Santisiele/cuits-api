import type { FastifyRequest, FastifyReply } from "fastify"
import { logForbidden } from "@auth/activityLogger.js"
import { isCreator } from "@domain/users.js"

export async function requireCreator(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isCreator(request.role)) return
  logForbidden(request.username, request.ip, request.url)
  await reply.code(403).send({ error: "forbidden", message: "Only the creator can do this" })
}
