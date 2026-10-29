import type { SwaggerTransform } from "@fastify/swagger"

const TAGS: readonly (readonly [string, string])[] = [
  ["/auth", "Auth"],
  ["/cuit", "CUIT"],
  ["/graph", "Graph"],
  ["/sources", "Sources"],
  ["/nodes", "Sources"],
  ["/trust-levels", "Trust levels"],
  ["/users", "Users"],
  ["/research", "Web research"],
  ["/birthdays", "Birthdays"],
  ["/crm", "CRM"],
  ["/activity", "Activity"],
]

const PUBLIC_ROUTES = new Set(["POST /auth/login", "POST /auth/logout"])

const unauthorized = {
  description: "No session, or it expired",
  type: "object",
  properties: { message: { type: "string" } },
} as const

export function tagFor(url: string): string {
  return TAGS.find(([prefix]) => url === prefix || url.startsWith(`${prefix}/`))?.[1] ?? "Other"
}

export function isPublicRoute(method: string | readonly string[], url: string): boolean {
  return [method].flat().some((verb) => PUBLIC_ROUTES.has(`${verb.toUpperCase()} ${url}`))
}

export const documentRoute: SwaggerTransform = ({ schema, url, route }) => {
  const tags = (schema as { tags?: string[] }).tags ?? [tagFor(url)]
  if (isPublicRoute(route.method, url)) return { url, schema: { ...schema, tags, security: [] } }
  const response = (schema as { response?: Record<string, unknown> }).response ?? {}
  return { url, schema: { ...schema, tags, response: { 401: unauthorized, ...response } } }
}
