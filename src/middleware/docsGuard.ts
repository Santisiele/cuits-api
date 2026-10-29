import type { FastifyReply, FastifyRequest } from "fastify"
import type { AuthResult } from "@auth/AuthService.js"
import { canAdminister } from "@domain/users.js"

export const DOCS_REALM = 'Basic realm="CUIT API docs", charset="UTF-8"'

export function parseBasicAuth(header: string | undefined): { username: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8")
  const separator = decoded.indexOf(":")
  if (separator <= 0) return null
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
}

export interface DocsGuardDeps {
  login: (username: string, password: string) => Promise<AuthResult>
  onFailed: (username: string, ip: string, reason: string) => void
  onViewed: (username: string, ip: string) => void
}

export function docsGuard({ login, onFailed, onViewed }: DocsGuardDeps) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const credentials = parseBasicAuth(request.headers.authorization)
    if (!credentials) {
      await reply.code(401).header("WWW-Authenticate", DOCS_REALM).send({ message: "Log in to read the API docs" })
      return
    }
    const result = await login(credentials.username, credentials.password)
    if (!result.success) {
      onFailed(credentials.username, request.ip, result.reason)
      await reply.code(401).header("WWW-Authenticate", DOCS_REALM).send({ message: "Invalid username or password" })
      return
    }
    if (!canAdminister(result.role)) {
      await reply.code(403).send({ message: "Only admins can read the API docs" })
      return
    }
    if (request.url.split("?")[0] === "/docs/json") onViewed(result.username, request.ip)
  }
}
