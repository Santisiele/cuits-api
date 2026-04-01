import type { FastifyInstance } from "fastify"
import { Neo4jSource } from "@sources/Neo4jSource.js"

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
                    inMyBase: { type: "boolean" },
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

  /**
 * Manually add a relationship between two existing Tax IDs
 */
  server.post<{
    Body: { fromTaxId: string; toTaxId: string; relationshipType: number }
  }>(
    "/graph/relationship",
    {
      schema: {
        summary: "Add a relationship between two Tax IDs",
        description: "Both Tax IDs must exist in the graph. Relationship type must be a valid code.",
        body: {
          type: "object",
          required: ["fromTaxId", "toTaxId", "relationshipType"],
          properties: {
            fromTaxId: { type: "string", description: "Source Tax ID" },
            toTaxId: { type: "string", description: "Target Tax ID" },
            relationshipType: { type: "number", description: "Relationship type code" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              message: { type: "string" },
              fromTaxId: { type: "string" },
              toTaxId: { type: "string" },
              relationshipType: { type: "string" },
            },
          },
          400: { $ref: "BadResponse" },
          404: { $ref: "NotFoundResponse" },
          409: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const { fromTaxId, toTaxId, relationshipType } = request.body

      if (fromTaxId === toTaxId) {
        return reply.code(400).send({ message: "From and To Tax IDs must be different" })
      }

      const relationshipName = neo4jSource.getRelationshipTypeName(relationshipType)
      if (!relationshipName) {
        return reply.code(400).send({
          message: `Invalid relationship type code: ${relationshipType}. Valid codes: ${neo4jSource.validRelationshipCodes().join(", ")}`,
        })
      }

      try {
        const result = await neo4jSource.addRelationship(fromTaxId, toTaxId, relationshipName)

        if (result === "not_found") {
          return reply.code(404).send({
            cuit: fromTaxId,
            found: false,
            message: "One or both Tax IDs not found in graph",
          })
        }

        if (result === "duplicate") {
          return reply.code(409).send({
            message: "Relationship already exists between these two Tax IDs",
          })
        }

        return reply.code(201).send({
          message: "Relationship created successfully",
          fromTaxId,
          toTaxId,
          relationshipType: relationshipName,
        })
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  /**
 * Delete a relationship between two Tax IDs
 */
  server.delete<{
    Body: { fromTaxId: string; toTaxId: string; relationshipType: number }
  }>(
    "/graph/relationship",
    {
      schema: {
        summary: "Delete a relationship between two Tax IDs",
        description: "Deletes a specific relationship between two existing Tax IDs",
        body: {
          type: "object",
          required: ["fromTaxId", "toTaxId", "relationshipType"],
          properties: {
            fromTaxId: { type: "string", description: "Source Tax ID" },
            toTaxId: { type: "string", description: "Target Tax ID" },
            relationshipType: { type: "number", description: "Relationship type code" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
          400: { $ref: "BadResponse" },
          404: { $ref: "NotFoundResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const { fromTaxId, toTaxId, relationshipType } = request.body

      if (fromTaxId === toTaxId) {
        return reply.code(400).send({ message: "From and To Tax IDs must be different" })
      }

      const relationshipName = neo4jSource.getRelationshipTypeName(relationshipType)
      if (!relationshipName) {
        return reply.code(400).send({
          message: `Invalid relationship type code: ${relationshipType}`,
        })
      }

      try {
        const result = await neo4jSource.deleteRelationship(fromTaxId, toTaxId, relationshipName)

        if (result === "not_found") {
          return reply.code(404).send({
            cuit: fromTaxId,
            found: false,
            message: "Relationship not found",
          })
        }

        return { message: "Relationship deleted successfully" }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )
}