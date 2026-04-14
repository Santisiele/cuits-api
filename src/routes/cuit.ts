import type { FastifyInstance, FastifyPluginOptions } from "fastify"
import { CsvSource } from "@infrastructure/csv/CsvSource.js"
import { Neo4jSource } from "@infrastructure/neo4j/Neo4jSource.js"
import { CuitSearchService, SourceRegistry, isValidCuit } from "@application/CuitSearchService.js"
import { parseMaxDepth, DEFAULT_MAX_DEPTH, MAX_ALLOWED_DEPTH } from "@helpers/routeHelpers.js"
import type { ISource } from "@ports/interfaces.js"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─── Plugin options ───────────────────────────────────────────────────────────

export interface CuitRoutesOptions extends FastifyPluginOptions {
  /**
   * Data sources to search across.
   * Defaults to the production sources (CSV + Neo4j) when not provided.
   * Pass mock sources in tests to avoid real I/O.
   */
  sources?: ISource[]
}

// ─── Default production sources ───────────────────────────────────────────────

function defaultSources(): ISource[] {
  return [
    new CsvSource("csv-poseidon", path.join(__dirname, "../../sources/Poseidon.csv")),
    new Neo4jSource(),
  ]
}

// ─── Route plugin ─────────────────────────────────────────────────────────────

/**
 * Multi-source CUIT search routes.
 *
 * Accepts an optional `sources` array via plugin options to allow
 * dependency injection in tests. Falls back to the production sources
 * (CSV + Neo4j) when no sources are provided.
 */
export default async function cuitRoutes(
  server: FastifyInstance,
  options: CuitRoutesOptions
) {
  const registry = new SourceRegistry(options.sources ?? defaultSources())
  const searchService = new CuitSearchService(registry)

  // ─── GET /cuit/:cuit ───────────────────────────────────────────────────────

  server.get<{
    Params: { cuit: string }
    Querystring: { maxDepth?: string }
  }>(
    "/cuit/:cuit",
    {
      schema: {
        summary: "Search for a CUIT across all sources",
        params: {
          type: "object",
          properties: {
            cuit: { type: "string", description: "CUIT in format XX-XXXXXXXX-X" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            maxDepth: { type: "string", description: `Maximum graph depth (default: ${DEFAULT_MAX_DEPTH}, max: ${MAX_ALLOWED_DEPTH})` },
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
      const { cuit } = request.params

      if (!isValidCuit(cuit)) {
        return reply.code(400).send({
          message: "Invalid CUIT format. Expected: XX-XXXXXXXX-X",
        })
      }

      const maxDepth = parseMaxDepth(request.query.maxDepth)
      if (maxDepth === null) {
        return reply.code(400).send({
          message: `Invalid maxDepth. Must be a number between 1 and ${MAX_ALLOWED_DEPTH}`,
        })
      }

      const { results, failedCount } = await searchService.searchAll(cuit, maxDepth)

      if (failedCount === registry.count && results.length === 0) {
        return reply.code(500).send({ message: "All sources failed" })
      }

      if (results.length === 0) {
        return reply.code(404).send({
          cuit,
          found: false,
          message: "CUIT not found in any source",
        })
      }

      return { cuit, found: true, results }
    }
  )
}