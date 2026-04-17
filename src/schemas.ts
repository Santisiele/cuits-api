/**
 * Shared OpenAPI/JSON schemas used across routes and tests.
 * All schemas are registered globally on the Fastify instance at startup.
 */
export const schemas = {
  SearchResult: {
    $id: "SearchResult",
    type: "object",
    properties: {
      cuit: { type: "string" },
      source: { type: "string" },
      file: { type: "string" },
      data: { type: "object", additionalProperties: true },
    },
  },
  SearchResponse: {
    $id: "SearchResponse",
    type: "object",
    properties: {
      cuit: { type: "string" },
      found: { type: "boolean" },
      results: {
        type: "array",
        items: { $ref: "SearchResult" },
      },
    },
  },
  BadResponse: {
    $id: "BadResponse",
    type: "object",
    properties: {
      cuit: { type: "string" },
      found: { type: "boolean" },
      message: { type: "string" },
    },
  },
  NotFoundResponse: {
    $id: "NotFoundResponse",
    type: "object",
    properties: {
      cuit: { type: "string" },
      found: { type: "boolean" },
      message: { type: "string" },
    },
  },
  UnauthorizedResponse: {
    $id: "UnauthorizedResponse",
    type: "object",
    properties: {
      message: { type: "string" },
    },
  },
  ServerErrorResponse: {
    $id: "ServerErrorResponse",
    type: "object",
    properties: {
      cuit: { type: "string" },
      found: { type: "boolean" },
      message: { type: "string" },
    },
  },
}