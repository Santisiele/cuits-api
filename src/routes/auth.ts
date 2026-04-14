import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { AuthService } from "@auth/AuthService.js"
import { logLogin, logLoginFailed, logLogout } from "@auth/activityLogger.js"

const authService = new AuthService()

/**
 * Public authentication routes (no JWT required).
 * Register these BEFORE the auth middleware hook.
 */
export default async function authRoutes(server: FastifyInstance) {

  // ─── POST /auth/login ───────────────────────────────────────────────────────

  server.post<{
    Body: { username: string; password: string }
  }>(
    "/auth/login",
    {
      schema: {
        summary: "Login with username and password",
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string" },
            password: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              token: { type: "string" },
              username: { type: "string" },
            },
          },
          401: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { username, password } = request.body
      const ip = request.ip

      const result = await authService.login(username, password)

      if (!result.success) {
        logLoginFailed(username, ip, result.reason)
        return reply.code(401).send({ message: "Invalid username or password" })
      }

      logLogin(result.username, ip)
      return { token: result.token, username: result.username }
    }
  )

  // ─── POST /auth/logout ──────────────────────────────────────────────────────

  server.post(
    "/auth/logout",
    {
      schema: {
        summary: "Logout — logs the session end",
        response: {
          200: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization
      if (authHeader?.startsWith("Bearer ")) {
        try {
          const payload = authService.verify(authHeader.slice(7))
          logLogout(payload.username, request.ip)
        } catch {
          // Token invalid or expired — still return 200
        }
      }
      return reply.send({ message: "Logged out" })
    }
  )
}