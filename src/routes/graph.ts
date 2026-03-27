import type { FastifyInstance } from "fastify"
import { Neo4jSource } from "../sources/Neo4jSource.js"

const neo4jSource = new Neo4jSource()

const DEFAULT_MAX_DEPTH = 3
const MAX_ALLOWED_DEPTH = 10

/**
 * Validates and parses maxDepth query parameter
 * @param value - Raw string value from query
 * @returns Parsed depth or null if invalid
 */
function parseMaxDepth(value?: string): number | null {
  if (!value) return DEFAULT_MAX_DEPTH
  const parsed = Number(value)
  if (isNaN(parsed) || parsed < 1 || parsed > MAX_ALLOWED_DEPTH) return null
  return parsed
}

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
            maxDepth: { type: "string", description: `Maximum path depth (default: ${DEFAULT_MAX_DEPTH}, max: ${MAX_ALLOWED_DEPTH})` },
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
      const { taxId } = request.params
      const maxDepth = parseMaxDepth(request.query.maxDepth)

      if (maxDepth === null) {
        return reply.code(400).send({
          message: `Invalid maxDepth. Must be a number between 1 and ${MAX_ALLOWED_DEPTH}`,
        })
      }

      try {
        const results = await neo4jSource.search(taxId, maxDepth)

        if (results.length === 0) {
          return reply.code(404).send({
            cuit: taxId,
            found: false,
            message: "Tax ID not found in graph",
          })
        }

        return { cuit: taxId, found: true, results }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({
          message: "Graph database unavailable",
        })
      }
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
            maxDepth: { type: "string", description: `Maximum path depth (default: ${DEFAULT_MAX_DEPTH}, max: ${MAX_ALLOWED_DEPTH})` },
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
          400: { $ref: "BadResponse" },
          404: { $ref: "NotFoundResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const { from, to, maxDepth: rawDepth } = request.query

      if (from === to) {
        return reply.code(400).send({
          message: "From and To Tax IDs must be different",
        })
      }

      const maxDepth = parseMaxDepth(rawDepth)

      if (maxDepth === null) {
        return reply.code(400).send({
          message: `Invalid maxDepth. Must be a number between 1 and ${MAX_ALLOWED_DEPTH}`,
        })
      }

      try {
        const path = await neo4jSource.findPath(from, to, maxDepth)

        if (!path) {
          return reply.code(404).send({
            cuit: from,
            found: false,
            message: "No path found between the two Tax IDs",
          })
        }

        return { found: true, path }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({
          message: "Graph database unavailable",
        })
      }
    }
  )
}