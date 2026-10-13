import type { FastifyInstance } from "fastify"
import { BirthdayProgressService } from "@application/BirthdayProgressService.js"
import { Neo4jBirthdaySweepRepository } from "@infrastructure/neo4j/Neo4jBirthdaySweepRepository.js"
import { requireCreator } from "@middleware/requireCreator.js"
import { logBirthdayProgressViewed } from "@auth/activityLogger.js"

const nullableString = { type: ["string", "null"] } as const

const progressSchema = {
  type: "object",
  properties: {
    knownPeople: { type: "number" },
    withBirthday: { type: "number" },
    missing: { type: "number" },
    bySource: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          people: { type: "number" },
          withBirthday: { type: "number" },
          missing: { type: "number" },
        },
      },
    },
    sweep: {
      type: "object",
      properties: {
        day: nullableString,
        consultedToday: { type: "number" },
        dailyLimit: { type: "number" },
        updatedAt: nullableString,
      },
    },
    misses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          taxId: { type: "string" },
          businessName: { type: "string" },
          missedOn: { type: "string" },
        },
      },
    },
    pending: {
      type: "array",
      items: {
        type: "object",
        properties: {
          taxId: { type: "string" },
          businessName: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
} as const

export default async function birthdayRoutes(server: FastifyInstance) {
  const service = new BirthdayProgressService(new Neo4jBirthdaySweepRepository())

  server.get(
    "/birthdays/progress",
    {
      preHandler: requireCreator,
      schema: { hide: true, response: { 200: progressSchema, 403: errorSchema } },
    },
    async (request) => {
      const progress = await service.progress()
      logBirthdayProgressViewed(request.username, progress.missing, progress.pending.length)
      return progress
    }
  )
}
