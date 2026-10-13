import "dotenv/config"
import fs from "fs"
import path from "path"
import { Neo4jUserRepository } from "@infrastructure/neo4j/Neo4jUserRepository.js"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { isSameUser, type StoredUser } from "@domain/users.js"

interface FileUser {
  username: string
  passwordHash: string
}

const args = process.argv.slice(2)
const apply = args.includes("--apply")
const creatorUsername = args.find((a) => !a.startsWith("--"))

if (!creatorUsername) {
  console.error("Usage: pnpm migrate:users <creatorUsername> [--apply]")
  process.exit(1)
}

const rawRoute = process.env["DATA_ROUTE"] ?? ""
const usersPath = path.isAbsolute(rawRoute) ? rawRoute : path.resolve(process.cwd(), rawRoute)

if (!rawRoute || !fs.existsSync(usersPath)) {
  console.error(`No users file at "${usersPath}". Set DATA_ROUTE to the users.json to migrate.`)
  process.exit(1)
}

const fileUsers = (JSON.parse(fs.readFileSync(usersPath, "utf-8")) as FileUser[]).filter(
  (u) => u.username && u.passwordHash
)

if (!fileUsers.some((u) => isSameUser(u.username, creatorUsername))) {
  console.error(`"${creatorUsername}" is not in ${usersPath}, so nobody would be the creator. Aborting.`)
  process.exit(1)
}

const repository = new Neo4jUserRepository()
const createdAt = new Date().toISOString()

console.log(`${apply ? "Migrating" : "Dry run:"} ${fileUsers.length} users from ${usersPath}`)

try {
  for (const fileUser of fileUsers) {
    const role = isSameUser(fileUser.username, creatorUsername) ? "creator" : "member"
    const existing = await repository.findByUsername(fileUser.username)
    if (existing) {
      console.log(`  ${fileUser.username}: already in the graph as ${existing.role}, left alone`)
      continue
    }
    if (!apply) {
      console.log(`  ${fileUser.username}: would be created as ${role}`)
      continue
    }
    const user: StoredUser = {
      username: fileUser.username,
      passwordHash: fileUser.passwordHash,
      role,
      createdAt,
      disabledAt: null,
    }
    const outcome = await repository.create(user)
    console.log(`  ${fileUser.username}: ${outcome === "created" ? `created as ${role}` : "already taken"}`)
  }
  if (!apply) console.log("Nothing written. Run again with --apply to migrate.")
} finally {
  await Neo4jDriver.close()
}
