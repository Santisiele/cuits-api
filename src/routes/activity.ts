import fs from "fs"
import readline from "readline"
import type { FastifyInstance } from "fastify"
import { ActivityLogService } from "@application/ActivityLogService.js"
import { requireCreator } from "@middleware/requireCreator.js"
import { LOG_FILE } from "@auth/activityLogger.js"
import { parseActivityFilters, rotatedLogNames } from "@domain/activityLog.js"

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

export default async function activityRoutes(server: FastifyInstance, options: { lines?: () => AsyncIterable<string> } = {}) {
  const service = new ActivityLogService(options.lines ?? logLines)

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
