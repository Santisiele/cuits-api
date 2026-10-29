import fs from "fs"
import readline from "readline"
import type { FastifyInstance } from "fastify"
import { ActivityLogService } from "@application/ActivityLogService.js"
import { requireCreator } from "@middleware/requireCreator.js"
import { LOG_FILE } from "@auth/activityLogger.js"
import { parseActivityFilters, rotatedLogNames, type ActivityEntry } from "@domain/activityLog.js"
import { manualRunEntry } from "@domain/manualRun.js"
import { Neo4jManualRunRepository } from "@infrastructure/neo4j/Neo4jManualRunRepository.js"

async function* logLines(): AsyncIterable<string> {
  for (const file of [...rotatedLogNames(LOG_FILE).reverse(), LOG_FILE]) {
    if (!fs.existsSync(file)) continue
    const lines = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity })
    for await (const line of lines) yield line
  }
}

const entrySchema = {
  type: "object",
  properties: {
    time: { type: "string" },
    level: { type: "string" },
    event: { type: "string" },
    username: { type: ["string", "null"] },
    details: { type: "object", additionalProperties: true },
  },
} as const

async function manualRunEntries(): Promise<ActivityEntry[]> {
  return (await new Neo4jManualRunRepository().list()).map(manualRunEntry)
}

export default async function activityRoutes(
  server: FastifyInstance,
  options: { lines?: () => AsyncIterable<string>; manualRuns?: () => Promise<ActivityEntry[]> } = {}
) {
  const service = new ActivityLogService(options.lines ?? logLines, options.manualRuns ?? manualRunEntries)

  server.get<{ Querystring: { limit?: string; before?: string; seen?: string; username?: string; event?: string } }>(
    "/activity",
    {
      preHandler: requireCreator,
      schema: {
        hide: true,
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string" },
            before: { type: "string" },
            seen: { type: "string" },
            username: { type: "string" },
            event: { type: "string" },
          },
        },
        response: {
          200: { type: "object", properties: { entries: { type: "array", items: entrySchema }, hasMore: { type: "boolean" } } },
          403: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } } },
        },
      },
    },
    async (request) => service.read(parseActivityFilters(request.query))
  )
}
