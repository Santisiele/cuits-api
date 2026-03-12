import type { FastifyInstance } from "fastify"
import type { ISource } from "@sources/ISource.js"
import { handleCuitSearch } from "@helpers/cuitHandler.js"

/**
 * CUIT search routes
 * @param server - Fastify instance
 * @param options - Route options including data sources
 */
export default async function cuitRoutes(
  server: FastifyInstance,
  options: { sources: ISource[] }
) {
  const { sources } = options

  server.get<{ Params: { cuit: string } }>(
    "/cuit/:cuit",
    {
      schema: {
        summary: "Search for a CUIT",
        description: "Searches across all connected data sources",
        params: {
          type: "object",
          properties: {
            cuit: { type: "string", description: "CUIT to search for" },
          },
        },
        response: {
          200: { $ref: "SearchResponse" },
          400: { $ref: "BadResponse" },
          404: { $ref: "NotFoundResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const cuit = request.params.cuit.trim()
      return handleCuitSearch(cuit, sources, reply)
    }
  )
}