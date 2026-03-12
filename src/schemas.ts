/**
 * Shared OpenAPI schemas used across routes and tests
 */
export const schemas = {
    SearchResult: {
        $id: "SearchResult",
        type: "object",
        properties: {
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