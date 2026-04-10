import type { FastifyRequest, FastifyReply } from "fastify"
import { AuthService } from "@auth/AuthService.js"
import { logUnauthorized } from "@auth/activityLogger.js"

const authService = new AuthService()

// ─── Request augmentation ─────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    /** Username extracted from the verified JWT. Set by the auth middleware. */
    username: string
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Fastify hook that verifies the JWT on every request to protected routes.
 *
 * Expects the token in the Authorization header: `Bearer <token>`
 *
 * On success: sets `request.username` for downstream handlers.
 * On failure: returns 401 and logs the unauthorized attempt.
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization

  if (!authHeader?.startsWith("Bearer ")) {
    logUnauthorized(request.ip, request.url, "missing_token")
    await reply.code(401).send({ message: "Authentication required" })
    return
  }

  const token = authHeader.slice(7)

  try {
    const payload = authService.verify(token)
    request.username = payload.username
  } catch {
    logUnauthorized(request.ip, request.url, "invalid_token")
    await reply.code(401).send({ message: "Invalid or expired token" })
  }
}
