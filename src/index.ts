import Fastify from "fastify"
import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
import cors from "@fastify/cors"
import graphRoutes from "@routes/graph.js"
import cuitRoutes from "@routes/cuit.js"
import authRoutes from "@routes/auth.js"
import { schemas } from "@schemas.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { authMiddleware } from "@middleware/authMiddleware.js"
import type { FastifyInstance } from "fastify"

// ─── Server setup ─────────────────────────────────────────────────────────────

const server = Fastify({ logger: { level: "error" } })

for (const schema of Object.values(schemas)) {
  server.addSchema(schema)
}

await server.register(swagger, {
  openapi: {
    info: {
      title: "CUIT API",
      description: "Search for CUITs across multiple data sources",
      version: "1.0.0",
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
})

await server.register(swaggerUi, { routePrefix: "/docs" })

await server.register(cors, {
  origin: process.env["FRONT_ROUTE"] ?? "",
  methods: ["GET", "POST", "DELETE", "PATCH"],
})

// ─── Public routes (no auth required) ────────────────────────────────────────

await server.register(authRoutes)

// ─── Protected routes (auth middleware scoped only to these) ─────────────────

/**
 * Wraps all protected routes in a scoped plugin so that the auth hooks
 * only apply within this scope and NOT to public routes like /auth/login.
 * Uses fastify-plugin with { skip: false } (default) to keep the scope.
 */
async function protectedRoutes(instance: FastifyInstance) {
  instance.addHook("preHandler", authMiddleware)

  await instance.register(cuitRoutes)
  await instance.register(graphRoutes)
}

await server.register(protectedRoutes)

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  await server.close()
  await Neo4jDriver.close()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

let targetPort = parseInt(process.env["PORT"] ?? "3000")

// ─── Start ────────────────────────────────────────────────────────────────────

try {
  await server.listen({ port: targetPort })
  console.log(`Server running at http://localhost:${targetPort}`)
  console.log(`Docs available at http://localhost:${targetPort}/docs`)
} catch (err) {
  server.log.error(err)
  await Neo4jDriver.close()
  process.exit(1)
}