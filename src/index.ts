import Fastify from "fastify"
import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
import cors from "@fastify/cors"
import graphRoutes from "@routes/graph.js"
import cuitRoutes from "@routes/cuit.js"
import { schemas } from "@schemas.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"

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
  },
})

await server.register(swaggerUi, { routePrefix: "/docs" })

await server.register(cors, {
  origin: "http://localhost:5173",
  methods: ["GET", "POST", "DELETE", "PATCH"],
})

await server.register(cuitRoutes)
await server.register(graphRoutes)

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  await server.close()
  await Neo4jDriver.close()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

// ─── Start ────────────────────────────────────────────────────────────────────

try {
  await server.listen({ port: 3000 })
  console.log("Server running at http://localhost:3000")
  console.log("Docs available at http://localhost:3000/docs")
} catch (err) {
  server.log.error(err)
  await Neo4jDriver.close()
  process.exit(1)
}