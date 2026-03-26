import type { FastifyInstance } from "fastify"
import { Neo4jSource } from "@sources/Neo4jSource.js"

const neo4jSource = new Neo4jSource()

/**
 * Graph-based routes for Neo4j queries
 */
export default async function graphRoutes(server: FastifyInstance) {

  /**
   * Search for a Tax ID in the graph database
   */
  server.get<{
    Params: { taxId: string }
    Querystring: { maxDepth?: string }
  }>(
    "/graph/cuit/:taxId",
    {
      schema: {
        summary: "Search for a Tax ID in the graph",
        description: "Returns node info if inMyBase, or paths to inMyBase nodes if not",
        params: {
          type: "object",
          properties: {
            taxId: { type: "string", description: "Tax ID to search for" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            maxDepth: { type: "string", description: "Maximum path depth (default: 3)" },
          },
        },
        response: {
          200: { $ref: "SearchResponse" },
          404: { $ref: "NotFoundResponse" },
        },
      },
    },
    async (request, reply) => {
      const { taxId } = request.params
      const maxDepth = Number(request.query.maxDepth ?? 3)

      const results = await neo4jSource.search(taxId, maxDepth)

      if (results.length === 0) {
        return reply.code(404).send({
          cuit: taxId,
          found: false,
          message: "Tax ID not found in graph",
        })
      }

      return { cuit: taxId, found: true, results }
    }
  )

  /**
   * Find path between two Tax IDs in the graph
   */
  server.get<{
    Querystring: { from: string; to: string; maxDepth?: string }
  }>(
    "/graph/path",
    {
      schema: {
        summary: "Find path between two Tax IDs",
        description: "Returns the shortest path between two Tax IDs in the graph",
        querystring: {
          type: "object",
          required: ["from", "to"],
          properties: {
            from: { type: "string", description: "Starting Tax ID" },
            to: { type: "string", description: "Target Tax ID" },
            maxDepth: { type: "string", description: "Maximum path depth (default: 3)" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              found: { type: "boolean" },
              path: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    taxId: { type: "string" },
                    businessName: { type: "string" },
                    relationshipType: { type: "string" },
                  },
                },
              },
            },
          },
          404: { $ref: "NotFoundResponse" },
        },
      },
    },
    async (request, reply) => {
      const { from, to, maxDepth } = request.query
      const depth = Number(maxDepth ?? 3)

      const path = await neo4jSource.findPath(from, to, depth)

      if (!path) {
        return reply.code(404).send({
          cuit: from,
          found: false,
          message: "No path found between the two Tax IDs",
        })
      }

      return { found: true, path }
    }
  )
}