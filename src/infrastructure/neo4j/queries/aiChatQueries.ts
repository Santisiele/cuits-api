export const AiChatQueries = {
  AI_CHAT_CONSTRAINT: `
    CREATE CONSTRAINT ai_chat_id_unique IF NOT EXISTS FOR (chat:AiChat) REQUIRE chat.id IS UNIQUE
  `,

  AI_CHAT_MESSAGE_CONSTRAINT: `
    CREATE CONSTRAINT ai_chat_message_id_unique IF NOT EXISTS FOR (message:AiChatMessage) REQUIRE message.id IS UNIQUE
  `,

  AI_CHAT_OWNER_INDEX: `
    CREATE INDEX ai_chat_owner IF NOT EXISTS FOR (chat:AiChat) ON (chat.createdBy)
  `,

  AI_CHAT_MESSAGE_CREATED_INDEX: `
    CREATE INDEX ai_chat_message_created IF NOT EXISTS FOR (message:AiChatMessage) ON (message.createdAt)
  `,

  LIST_AI_CHATS: `
    MATCH (chat:AiChat {createdBy: $owner})
    WHERE chat.archivedAt IS NULL
    RETURN chat
    ORDER BY chat.updatedAt DESC
  `,

  FIND_AI_CHAT: `
    MATCH (chat:AiChat {id: $id})
    RETURN chat
  `,

  CREATE_AI_CHAT: `
    CREATE (:AiChat {
      id: $id,
      title: $title,
      createdBy: $createdBy,
      createdAt: $createdAt,
      updatedAt: $updatedAt
    })
  `,

  ARCHIVE_AI_CHAT: `
    MATCH (chat:AiChat {id: $id})
    SET chat.archivedAt = $archivedAt
  `,

  LIST_AI_CHAT_MESSAGES: `
    MATCH (message:AiChatMessage)-[:IN]->(chat:AiChat {id: $chatId})
    RETURN message, chat.id AS chatId
    ORDER BY message.createdAt, message.role DESC
  `,

  FIND_AI_CHAT_MESSAGE: `
    MATCH (message:AiChatMessage {id: $id})-[:IN]->(chat:AiChat)
    RETURN message, chat.id AS chatId
  `,

  ADD_AI_CHAT_MESSAGE: `
    MATCH (chat:AiChat {id: $chatId})
    SET chat.updatedAt = $updatedAt
    CREATE (:AiChatMessage {
      id: $id,
      role: $role,
      createdAt: $createdAt,
      text: $text,
      sources: $sources,
      tables: $tables,
      status: $status,
      model: $model,
      inputTokens: $inputTokens,
      outputTokens: $outputTokens,
      cacheReadTokens: $cacheReadTokens,
      webSearches: $webSearches,
      costUsd: $costUsd
    })-[:IN]->(chat)
  `,

  RECORD_AI_CHAT_USAGE: `
    MATCH (message:AiChatMessage {id: $id})
    SET message.model = $model,
        message.inputTokens = $inputTokens,
        message.outputTokens = $outputTokens,
        message.cacheReadTokens = $cacheReadTokens,
        message.webSearches = $webSearches,
        message.costUsd = $costUsd
  `,

  FINISH_AI_CHAT_MESSAGE: `
    MATCH (message:AiChatMessage {id: $id})
    SET message.status = $status,
        message.text = $text,
        message.sources = $sources,
        message.tables = $tables,
        message.model = $model,
        message.inputTokens = $inputTokens,
        message.outputTokens = $outputTokens,
        message.cacheReadTokens = $cacheReadTokens,
        message.webSearches = $webSearches,
        message.costUsd = $costUsd
  `,

  FAIL_RUNNING_AI_CHAT_MESSAGES: `
    MATCH (message:AiChatMessage {status: "running"})
    SET message.status = "failed"
    RETURN count(message) AS failed
  `,

  SUM_AI_CHAT_SINCE: `
    MATCH (message:AiChatMessage)
    WHERE message.createdAt >= $since AND message.role = "assistant"
    RETURN coalesce(sum(message.costUsd), 0.0) AS totalUsd, count(message) AS count
  `,
} as const
