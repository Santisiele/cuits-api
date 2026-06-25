/**
 * CLI script to add a new user to users file.
 *
 * Usage:
 *   pnpm tsx src/scripts/createUser.ts <username> <password>
 *
 * Example:
 *   pnpm tsx src/scripts/createUser.ts admin mySecurePassword123
 *
 * The password is hashed with bcrypt before being written to the file.
 * Run this once per user — re-running with the same username will error.
 */

import "dotenv/config"
import fs from "fs"
import path from "path"
import bcrypt from "bcrypt"
import type { User } from "@auth/UserRepository.js"

/**
 * Resolves DATA_ROUTE into an absolute path.
 *  - If the env var is already absolute (e.g. "/data/users.json" in Railway
 *    with a volume mounted at /data), use it as-is.
 *  - Otherwise, resolve it relative to the project root (process.cwd()).
 *
 * IMPORTANT: never use `path.join(cwd, route)` — `path.join` does NOT
 * preserve absolute paths in the second argument, so "/data/users.json"
 * would become "/app/data/users.json" on Railway, which lives on the
 * ephemeral filesystem and gets wiped on every deploy.
 */
const rawRoute = process.env["DATA_ROUTE"] ?? ""
const USERS_PATH = path.isAbsolute(rawRoute)
  ? rawRoute
  : path.resolve(process.cwd(), rawRoute)

const SALT_ROUNDS = 12

const username = process.argv[2]
const password = process.argv[3]

if (!username || !password) {
  console.error("Usage: pnpm tsx src/scripts/createUser.ts <username> <password>")
  process.exit(1)
}

// Load existing users, filtering out any empty/malformed entries
const users: User[] = fs.existsSync(USERS_PATH)
  ? (JSON.parse(fs.readFileSync(USERS_PATH, "utf-8")) as User[]).filter((u) => u.username)
  : []

// Check for duplicates
if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
  console.error(`Error: user "${username}" already exists.`)
  process.exit(1)
}

// Hash password and save
const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
users.push({ username, passwordHash })

// Ensure data directory exists
fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true })
fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), "utf-8")

console.log(`✓ User "${username}" created successfully at ${USERS_PATH}`)