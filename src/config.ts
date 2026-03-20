import "dotenv/config"

/**
 * Application configuration loaded from environment variables.
 * All required variables must be set in .env
 */
export const config = {
  neo4j: {
    uri: process.env["NEO4J_URI"] ?? "",
    user: process.env["NEO4J_USERNAME"] ?? "neo4j",
    password: process.env["NEO4J_PASSWORD"] ?? "",
  },
  nosis: {
    user: process.env["NOSIS_USER"] ?? "",
    password: process.env["NOSIS_PASSWORD"] ?? "",
  },
} as const