import type { FastifyInstance } from "fastify"
import { Neo4jSource } from "@infrastructure/neo4j/Neo4jSource.js"
import { parseMaxDepth, DEFAULT_MAX_DEPTH, MAX_ALLOWED_DEPTH } from "@helpers/routeHelpers.js"
import { logCuitSearch, logPathSearch, logRelationshipAdded, logRelationshipDeleted, logNodeUpdated, logNodeViewed, logNodeRelationshipsViewed, logMyBaseViewed, logCompaniesViewed, logBirthdaysViewed, logToKnowViewed, logAllMyNodesViewed, logNameSearch } from "@auth/activityLogger.js"

const neo4jSource = new Neo4jSource()

/**
 * Parses a date string into its day/month components.
 * Accepts dd/mm/yyyy, dd-mm-yyyy, or just dd/mm (year ignored).
 * Returns null when the string can't be parsed or the values are out of range.
 */
function parseDayMonth(raw: string): { day: number; month: number } | null {
  const match = /^(\d{1,2})[/-](\d{1,2})(?:[/-]\d{2,4})?$/.exec(raw.trim())
  if (!match) return null
  const day = Number(match[1])
  const month = Number(match[2])
  if (!Number.isFinite(day) || !Number.isFinite(month)) return null
  if (day < 1 || day > 31 || month < 1 || month > 12) return null
  return { day, month }
}

/**
 * Graph-based routes for Neo4j queries.
 */
export default async function graphRoutes(server: FastifyInstance) {

  // ─── GET /graph/cuit/:taxId ───────────────────────────────────────────────

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
          401: { $ref: "UnauthorizedResponse" },
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
          logCuitSearch(request.username, taxId, false)
          return reply.code(404).send({
            cuit: taxId,
            found: false,
            message: "Tax ID not found in graph",
          })
        }

        logCuitSearch(request.username, taxId, true)
        return { cuit: taxId, found: true, results }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── GET /graph/path ─────────────────────────────────────────────────────

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
                    from: {
                      type: "object",
                      properties: {
                        taxId: { type: "string" },
                        businessName: { type: "string" },
                        inMyBase: { type: "boolean" },
                      },
                    },
                    to: {
                      type: "object",
                      properties: {
                        taxId: { type: "string" },
                        businessName: { type: "string" },
                        inMyBase: { type: "boolean" },
                      },
                    },
                    relationships: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          400: { $ref: "BadResponse" },
          404: { $ref: "NotFoundResponse" },
          401: { $ref: "UnauthorizedResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const { from, to, maxDepth: rawDepth } = request.query

      if (from === to) {
        return reply.code(400).send({ message: "From and To Tax IDs must be different" })
      }

      const maxDepth = parseMaxDepth(rawDepth)
      if (maxDepth === null) {
        return reply.code(400).send({
          message: `Invalid maxDepth. Must be a number between 1 and ${MAX_ALLOWED_DEPTH}`,
        })
      }

      try {
        const path = await neo4jSource.findShortestPath(from, to, maxDepth)

        if (!path) {
          logPathSearch(request.username, from, to, false)
          return reply.code(404).send({
            cuit: from,
            found: false,
            message: "No path found between the two Tax IDs",
          })
        }

        logPathSearch(request.username, from, to, true)
        return { found: true, path }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── POST /graph/relationship ────────────────────────────────────────────

  server.post<{
    Body: { fromTaxId: string; toTaxId: string; relationshipType: number }
  }>(
    "/graph/relationship",
    {
      schema: {
        summary: "Add a relationship between two Tax IDs",
        body: {
          type: "object",
          required: ["fromTaxId", "toTaxId", "relationshipType"],
          properties: {
            fromTaxId: { type: "string" },
            toTaxId: { type: "string" },
            relationshipType: { type: "number" },
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
          409: { type: "object", properties: { message: { type: "string" } } },
          401: { $ref: "UnauthorizedResponse" },
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

        logRelationshipAdded(request.username, fromTaxId, toTaxId, relationshipName)
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

  // ─── DELETE /graph/relationship ──────────────────────────────────────────

  server.delete<{
    Body: { fromTaxId: string; toTaxId: string; relationshipType: number }
  }>(
    "/graph/relationship",
    {
      schema: {
        summary: "Delete a relationship between two Tax IDs",
        body: {
          type: "object",
          required: ["fromTaxId", "toTaxId", "relationshipType"],
          properties: {
            fromTaxId: { type: "string" },
            toTaxId: { type: "string" },
            relationshipType: { type: "number" },
          },
        },
        response: {
          200: { type: "object", properties: { message: { type: "string" } } },
          400: { $ref: "BadResponse" },
          404: { $ref: "NotFoundResponse" },
          401: { $ref: "UnauthorizedResponse" },
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

        logRelationshipDeleted(request.username, fromTaxId, toTaxId, relationshipName)
        return { message: "Relationship deleted successfully" }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── GET /graph/node/:taxId ──────────────────────────────────────────────

  server.get<{ Params: { taxId: string } }>(
    "/graph/node/:taxId",
    {
      schema: {
        summary: "Get node info by Tax ID",
        params: { type: "object", properties: { taxId: { type: "string" } } },
        response: {
          200: {
            type: "object",
            properties: {
              taxId: { type: "string" },
              businessName: { type: "string" },
              phone: { type: "string" },
              email: { type: "string" },
              birthday: { type: "string" },
              entryDate: { type: "string" },
              exitDate: { type: "string" },
              loadedAt: { type: "string" },
              inMyBase: { type: "boolean" },
              sources: { type: "array", items: { type: "string" } },
            },
          },
          404: { $ref: "NotFoundResponse" },
          401: { $ref: "UnauthorizedResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const { taxId } = request.params
      try {
        const node = await neo4jSource.findNode(taxId)
        if (!node) {
          logNodeViewed(request.username, taxId, null, null, null, null)
          return reply.code(404).send({
            cuit: taxId,
            found: false,
            message: "Tax ID not found in graph",
          })
        }
        logNodeViewed(request.username, taxId, node.businessName, node.entryDate, node.exitDate, node.loadedAt)
        return node
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── PATCH /graph/node/:taxId ────────────────────────────────────────────

  server.patch<{
    Params: { taxId: string }
    Body: { phone?: string; email?: string; birthday?: string, entryDate?: string, exitDate?: string, loadedAt?: string }
  }>(
    "/graph/node/:taxId",
    {
      schema: {
        summary: "Update node fields",
        params: { type: "object", properties: { taxId: { type: "string" } } },
        body: {
          type: "object",
          properties: {
            phone: { type: "string" },
            email: { type: "string" },
            birthday: { type: "string" },
            entryDate: { type: "string" },
            exitDate: { type: "string" },
            loadedAt: { type: "string" },
          },
        },
        response: {
          200: { type: "object", properties: { message: { type: "string" } } },
          404: { $ref: "NotFoundResponse" },
          401: { $ref: "UnauthorizedResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const { taxId } = request.params
      const { phone, email, birthday, entryDate, exitDate, loadedAt } = request.body
      try {
        const fields = Object.fromEntries(
          Object.entries({ phone, email, birthday }).filter(([, v]) => v !== undefined)
        ) as { phone?: string; email?: string; birthday?: string, entryDate?: string, exitDate?: string, loadedAt?: string }
        const result = await neo4jSource.updateNode(taxId, fields)
        if (result === "not_found") {
          return reply.code(404).send({
            cuit: taxId,
            found: false,
            message: "Tax ID not found in graph",
          })
        }
        logNodeUpdated(request.username, taxId)
        return { message: "Node updated successfully" }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── GET /graph/node/:taxId/relationships ────────────────────────────────

  server.get<{
    Params: { taxId: string }
    Querystring: { maxDepth?: string }
  }>(
    "/graph/node/:taxId/relationships",
    {
      schema: {
        summary: "Get all relationships of a node",
        params: { type: "object", properties: { taxId: { type: "string" } } },
        querystring: {
          type: "object",
          properties: {
            maxDepth: { type: "string", description: `Maximum depth (default: ${DEFAULT_MAX_DEPTH}, max: ${MAX_ALLOWED_DEPTH})` },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              taxId: { type: "string" },
              found: { type: "boolean" },
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    cuit: { type: "string" },
                    sources: { type: "array", items: { type: "string" } },
                    file: { type: "string" },
                    data: { type: "object", additionalProperties: true },
                  },
                },
              },
            },
          },
          404: { $ref: "NotFoundResponse" },
          401: { $ref: "UnauthorizedResponse" },
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
        const results = await neo4jSource.findAllRelationships(taxId, maxDepth)

        if (!results) {
          logNodeRelationshipsViewed(request.username, taxId, maxDepth, 0)
          return reply.code(404).send({
            cuit: taxId,
            found: false,
            message: "Tax ID not found in graph",
          })
        }

        logNodeRelationshipsViewed(request.username, taxId, maxDepth, results.length)
        return { taxId, found: true, results }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── GET /graph/nodes ────────────────────────────────────────────────────

  server.get(
    "/graph/nodes",
    {
      schema: {
        summary: "Get all nodes in my base",
        response: {
          200: {
            type: "object",
            properties: {
              nodes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    taxId: { type: "string" },
                    businessName: { type: "string" },
                    sources: { type: "array", items: { type: "string" } },
                    relationshipCount: { type: "number" },
                  },
                },
              },
            },
          },
          401: { $ref: "UnauthorizedResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      try {
        const nodes = await neo4jSource.findMyBaseNodes()
        logMyBaseViewed(request.username, nodes.length)
        return { nodes }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )


  // ─── GET /graph/companies ─────────────────────────────────────────────────

  server.get(
    "/graph/companies",
    {
      schema: {
        summary: "Get all company nodes to search",
        description: "Returns nodes with taxId starting with 30 or 33 and inMyBase = false, ordered by Principal relationship count",
        response: {
          200: {
            type: "object",
            properties: {
              nodes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    taxId: { type: "string" },
                    businessName: { type: "string" },
                    sources: { type: "array", items: { type: "string" } },
                    relationshipCount: { type: "number" },
                    relatedSources: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          401: { $ref: "UnauthorizedResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      try {
        const nodes = await neo4jSource.findCompanyNodes()
        logCompaniesViewed(request.username, nodes.length)
        return { nodes }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── GET /graph/search-by-name ────────────────────────────────────────────

  server.get<{
    Querystring: { q?: string; limit?: string }
  }>(
    "/graph/search-by-name",
    {
      schema: {
        summary: "Search nodes by business name across the whole graph",
        description:
          "Case-insensitive substring match on businessName. Searches every " +
          "CUIT node, not just the ones in the base, because the point of " +
          "searching by name is to find a company whose CUIT you don't know.",
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", description: "Name fragment, at least 3 characters" },
            limit: { type: "string", description: "Max results (default 50, max 200)" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              count: { type: "number" },
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    taxId: { type: "string" },
                    businessName: { type: "string" },
                    sources: { type: "array", items: { type: "string" } },
                    inMyBase: { type: "boolean" },
                    relationshipCount: { type: "number" },
                  },
                },
              },
            },
          },
          400: { $ref: "BadResponse" },
          401: { $ref: "UnauthorizedResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const query = (request.query.q ?? "").trim()

      /**
       * Two characters would match a large share of the graph and turn every
       * keystroke into a full scan, so the floor is enforced here rather than
       * left to the caller.
       */
      if (query.length < 3) {
        return reply.code(400).send({
          message: "La búsqueda por nombre necesita al menos 3 caracteres",
        })
      }

      const parsedLimit = Number(request.query.limit ?? 50)
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 200)
        : 50

      try {
        const results = await neo4jSource.searchNodesByName(query, limit)
        logNameSearch(request.username, query, results.length)
        return { count: results.length, results }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── GET /graph/birthdays ─────────────────────────────────────────────────

  server.get<{
    Querystring: { from?: string; to?: string }
  }>(
    "/graph/birthdays",
    {
      schema: {
        summary: "List inMyBase nodes whose birthday falls in a date range",
        description:
          "Both endpoints (from and to) are inclusive and use dd/mm/yyyy. " +
          "Year is ignored — only month and day are matched. The range can " +
          "wrap around the year boundary (e.g. from=20/12 to=05/01).",
        querystring: {
          type: "object",
          required: ["from", "to"],
          properties: {
            from: { type: "string", description: "dd/mm/yyyy or dd/mm" },
            to: { type: "string", description: "dd/mm/yyyy or dd/mm" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              count: { type: "number" },
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    taxId: { type: "string" },
                    businessName: { type: "string" },
                    birthday: { type: "string" },
                    sources: { type: "array", items: { type: "string" } },
                    relationshipCount: { type: "number" },
                  },
                },
              },
            },
          },
          400: { $ref: "BadResponse" },
          401: { $ref: "UnauthorizedResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      const fromRaw = request.query.from ?? ""
      const toRaw = request.query.to ?? ""

      const from = parseDayMonth(fromRaw)
      const to = parseDayMonth(toRaw)

      if (!from || !to) {
        return reply.code(400).send({
          message: "Invalid date format. Use dd/mm/yyyy (year optional).",
        })
      }

      try {
        const results = await neo4jSource.findBirthdaysBetween(
          from.month, from.day,
          to.month, to.day
        )

        logBirthdaysViewed(request.username, fromRaw, toRaw, results.length)
        return { count: results.length, results }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── GET /graph/to-know ───────────────────────────────────────────────────

  /**
   * Lists all "por conocer" nodes (isToKnow = true).
   *
   * A node that is also isKnown appears here too — the two flags are
   * independent classifications, and this view is the "objetivos" mirror
   * of GET /graph/nodes (which lists the isKnown group).
   */
  server.get(
    "/graph/to-know",
    {
      schema: {
        summary: "Get all objetivos (isToKnow) nodes",
        description: "Returns all nodes flagged as isToKnow = true.",
        response: {
          200: {
            type: "object",
            properties: {
              nodes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    taxId: { type: "string" },
                    businessName: { type: "string" },
                    sources: { type: "array", items: { type: "string" } },
                    isKnown: { type: "boolean" },
                    isToKnow: { type: "boolean" },
                    relationshipCount: { type: "number" },
                  },
                },
              },
            },
          },
          401: { $ref: "UnauthorizedResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      try {
        const nodes = await neo4jSource.findToKnowNodes()
        logToKnowViewed(request.username, nodes.length)
        return { nodes }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )

  // ─── GET /graph/base-full ──────────────────────────────────────────────────

  /**
   * Lists every node the user considers "their own" — the union of the
   * conocidos (isKnown) and por conocer (isToKnow) groups. Nodes that are
   * both appear once.
   */
  server.get(
    "/graph/base-full",
    {
      schema: {
        summary: "Get all my nodes (union of isKnown and isToKnow)",
        response: {
          200: {
            type: "object",
            properties: {
              nodes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    taxId: { type: "string" },
                    businessName: { type: "string" },
                    sources: { type: "array", items: { type: "string" } },
                    isKnown: { type: "boolean" },
                    isToKnow: { type: "boolean" },
                    relationshipCount: { type: "number" },
                  },
                },
              },
            },
          },
          401: { $ref: "UnauthorizedResponse" },
          500: { $ref: "ServerErrorResponse" },
        },
      },
    },
    async (request, reply) => {
      try {
        const nodes = await neo4jSource.findAllMyNodes()
        logAllMyNodesViewed(request.username, nodes.length)
        return { nodes }
      } catch (error) {
        request.log.error(error)
        return reply.code(500).send({ message: "Graph database unavailable" })
      }
    }
  )
}

