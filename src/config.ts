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
  backup: {
    resendApiKey: process.env["RESEND_API_KEY"] ?? "",
    from: process.env["BACKUP_EMAIL_FROM"] ?? "",
    to: process.env["BACKUP_EMAIL_TO"] ?? "",
    passphrase: process.env["BACKUP_PASSPHRASE"] ?? "",
  },
  auth: {
    /** Secret used to sign JWTs. Must be a long random string in production. */
    jwtSecret: process.env["JWT_SECRET"] ?? "change-this-secret-in-production",
    /** How long a token is valid. Examples: "8h", "1d", "7d" */
    jwtExpiresIn: (process.env["JWT_EXPIRES_IN"] ?? "1h") as string,
  },
} as const