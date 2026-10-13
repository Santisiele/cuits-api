import type { FastifyRequest, FastifyReply } from "fastify"
import { logForbidden } from "@auth/activityLogger.js"

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.role === "admin") return
  logForbidden(request.username, request.ip, request.url)
  await reply.code(403).send({ error: "forbidden", message: "Only an admin can do this" })
}
