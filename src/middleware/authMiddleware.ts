import type { FastifyRequest, FastifyReply } from "fastify"
import { AuthService } from "@auth/AuthService.js"
import { logUnauthorized } from "@auth/activityLogger.js"
import type { Role } from "@domain/users.js"

// ─── Request augmentation ─────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    /** Username extracted from the verified JWT. Set by the auth middleware. */
    username: string
    role: Role
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

type SessionResolver = Pick<AuthService, "resolveSession">

export function createAuthMiddleware(authService: SessionResolver) {
  return async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization

    if (!authHeader?.startsWith("Bearer ")) {
      logUnauthorized(request.ip, request.url, "missing_token")
      await reply.code(401).send({ message: "Authentication required" })
      return
    }

    const session = await authService.resolveSession(authHeader.slice(7))
    if (!session.valid) {
      logUnauthorized(request.ip, request.url, session.reason)
      await reply.code(401).send({ message: "Invalid or expired token" })
      return
    }

    request.username = session.username
    request.role = session.role
  }
}

export const authMiddleware = createAuthMiddleware(new AuthService())
