import "dotenv/config"
import { UserAdminService, UserAdminError } from "@application/UserAdminService.js"
import { Neo4jUserRepository } from "@infrastructure/neo4j/Neo4jUserRepository.js"
import { BcryptPasswordHasher } from "@infrastructure/auth/BcryptPasswordHasher.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"

const [username, password, role = "member"] = process.argv.slice(2)

if (!username || !password) {
  console.error("Usage: pnpm create:user <username> <password> [admin|member]")
  process.exit(1)
}

const service = new UserAdminService(new Neo4jUserRepository(), new BcryptPasswordHasher())

try {
  const user = await service.create(username, password, role)
  console.log(`User "${user.username}" created as ${user.role}`)
} catch (err) {
  if (!(err instanceof UserAdminError)) throw err
  console.error(`Error: ${err.message}`)
  process.exitCode = 1
} finally {
  await Neo4jDriver.close()
}
