import Fastify from "fastify"
import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"
import path from "path"
import { fileURLToPath } from "url"
import { CsvSource } from "@sources/CsvSource.js"
import type { ISource } from "@sources/ISource.js"
import cuitRoutes from "@routes/cuit.js"
import { schemas } from "@schemas"

// Standard workaround for ESM because it doesn't have __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * All registered data sources.
 */
export const sources: ISource[] = [
  new CsvSource("csv-poseidon", path.join(__dirname, "../sources/Poseidon.csv")),
]

const server = Fastify({
  logger: {
    level: "error"
  }
})

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

await server.register(swaggerUi, {
  routePrefix: "/docs",
})

await server.register(cuitRoutes, {sources})

try {
  await server.listen({ port: 3000 })
  console.log("Server running at http://localhost:3000")
  console.log("Docs available at http://localhost:3000/docs")
} catch (err) {
  server.log.error(err)
  process.exit(1)
}