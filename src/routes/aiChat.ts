import type { FastifyInstance, FastifyReply } from "fastify"
import { AiChatError, AiChatService } from "@application/AiChatService.js"
import { WebResearchService } from "@application/WebResearchService.js"
import { Neo4jAiChatRepository } from "@infrastructure/neo4j/Neo4jAiChatRepository.js"
import { Neo4jGraphReader } from "@infrastructure/neo4j/Neo4jGraphReader.js"
import { Neo4jWebResearchRepository } from "@infrastructure/neo4j/Neo4jWebResearchRepository.js"
import { ClaudeChatAssistant } from "@infrastructure/anthropic/ClaudeChatAssistant.js"
import { requireAdmin } from "@middleware/requireAdmin.js"
import { logAiChatAnswer } from "@auth/activityLogger.js"
import { config } from "@config.js"
import type { AiChatRejection } from "@domain/aiChat.js"

const STATUS_BY_REASON: Record<AiChatRejection, number> = {
  invalid_question: 400,
  chat_not_found: 404,
  message_not_found: 404,
  chat_busy: 409,
  budget_exhausted: 409,
  research_off: 503,
}

function handleError(err: unknown, reply: FastifyReply) {
  if (!(err instanceof AiChatError)) throw err
  return reply.code(STATUS_BY_REASON[err.reason]).send({ error: err.reason, message: err.message })
}

const chatSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    archivedAt: { type: ["string", "null"] },
  },
} as const

const messageSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    chatId: { type: "string" },
    role: { type: "string" },
    createdAt: { type: "string" },
    text: { type: "string" },
    status: { type: "string" },
    sources: {
      type: "array",
      items: { type: "object", properties: { url: { type: "string" }, title: { type: "string" } } },
    },
    tables: {
      type: "array",
      items: {
        type: "object",
        properties: {
          resultId: { type: "string" },
          title: { type: "string" },
          columns: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "array", items: {} } },
          truncated: { type: "boolean" },
        },
      },
    },
    model: { type: "string" },
    costUsd: { type: "number" },
    webSearches: { type: "number" },
  },
} as const

const chatWithMessagesSchema = {
  type: "object",
  properties: { chat: chatSchema, messages: { type: "array", items: messageSchema } },
} as const

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
} as const

const idParams = { type: "object", properties: { id: { type: "string" } } } as const

const questionBody = { type: "object", properties: { question: {} } } as const

type QuestionBody = { Body: { question?: unknown } | undefined }

export default async function aiChatRoutes(server: FastifyInstance) {
  const apiKey = config.anthropic.apiKey
  const budget = new WebResearchService(new Neo4jWebResearchRepository(), null)
  const service = new AiChatService(
    new Neo4jAiChatRepository(),
    apiKey ? ClaudeChatAssistant.withApiKey(apiKey) : null,
    new Neo4jGraphReader(),
    () => budget.budget(),
    logAiChatAnswer
  )

  server.get(
    "/ai-chat",
    {
      preHandler: requireAdmin,
      schema: {
        hide: true,
        response: { 200: { type: "object", properties: { chats: { type: "array", items: chatSchema } } }, 403: errorSchema },
      },
    },
    async (request) => ({ chats: await service.list(request.username) })
  )

  server.post<QuestionBody>(
    "/ai-chat",
    {
      preHandler: requireAdmin,
      schema: {
        hide: true,
        body: questionBody,
        response: { 201: chatWithMessagesSchema, 400: errorSchema, 403: errorSchema, 409: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      try {
        return reply.code(201).send(await service.start(request.username, request.body?.question))
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.get<{ Params: { id: string } }>(
    "/ai-chat/messages/:id",
    {
      preHandler: requireAdmin,
      schema: { hide: true, params: idParams, response: { 200: messageSchema, 403: errorSchema, 404: errorSchema } },
    },
    async (request, reply) => {
      try {
        return await service.message(request.username, request.params.id)
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.get<{ Params: { id: string } }>(
    "/ai-chat/:id",
    {
      preHandler: requireAdmin,
      schema: { hide: true, params: idParams, response: { 200: chatWithMessagesSchema, 403: errorSchema, 404: errorSchema } },
    },
    async (request, reply) => {
      try {
        return await service.open(request.username, request.params.id)
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.post<{ Params: { id: string } } & QuestionBody>(
    "/ai-chat/:id/messages",
    {
      preHandler: requireAdmin,
      schema: {
        hide: true,
        params: idParams,
        body: questionBody,
        response: {
          201: chatWithMessagesSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.code(201).send(await service.ask(request.username, request.params.id, request.body?.question))
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )

  server.post<{ Params: { id: string } }>(
    "/ai-chat/:id/archive",
    {
      preHandler: requireAdmin,
      schema: { hide: true, params: idParams, response: { 200: chatSchema, 403: errorSchema, 404: errorSchema } },
    },
    async (request, reply) => {
      try {
        return await service.archive(request.username, request.params.id)
      } catch (err) {
        return handleError(err, reply)
      }
    }
  )
}
