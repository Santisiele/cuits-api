import "dotenv/config"
import Fastify from "fastify"
import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
import cors from "@fastify/cors"
import rateLimit from "@fastify/rate-limit"
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

const allowedOrigins = [
  process.env["FRONT_ROUTE"] ?? "http://localhost:5173",
  "http://localhost:5173",
]

console.log("Allowed CORS origins:", allowedOrigins)

await server.register(cors, {
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) {
      cb(null, true)
    } else {
      cb(new Error("Not allowed by CORS"), false)
    }
  },
  methods: ["GET", "POST", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
})

// ─── Rate limiting ────────────────────────────────────────────────────────────

await server.register(rateLimit, {
  max: 60,
  timeWindow: "1 minute",
  errorResponseBuilder: () => ({
    message: "Demasiadas solicitudes, intentá de nuevo en un minuto",
  }),
})

// ─── Public routes (no auth required) ────────────────────────────────────────

await server.register(authRoutes)

// ─── Protected routes ─────────────────────────────────────────────────────────

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

// ─── Start ────────────────────────────────────────────────────────────────────

const targetPort = parseInt(process.env["PORT"] ?? "3000")

try {
  await server.listen({ port: targetPort, host: "0.0.0.0" })
  console.log(`Server running at http://localhost:${targetPort}`)
  console.log(`Docs available at http://localhost:${targetPort}/docs`)
} catch (err) {
  server.log.error(err)
  await Neo4jDriver.close()
  process.exit(1)
}