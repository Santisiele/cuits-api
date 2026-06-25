import fs from "fs"
import path from "path"

/**
 * Resolves DATA_ROUTE into an absolute path.
 *  - If the env var is already absolute (e.g. "/data/users.json" in Railway
 *    with a volume mounted at /data), use it as-is.
 *  - Otherwise, resolve it relative to the project root (process.cwd()),
 *    which is the typical local-dev case (e.g. "./data/users.json").
 *
 * IMPORTANT: never use `path.join(cwd, route)` here — `path.join` does NOT
 * preserve absolute paths in the second argument, so an env value like
 * "/data/users.json" would become "/app/data/users.json" on Railway,
 * which lives on the ephemeral filesystem and gets wiped on every deploy.
 */
const rawRoute = process.env["DATA_ROUTE"] ?? ""
const USERS_PATH = path.isAbsolute(rawRoute)
  ? rawRoute
  : path.resolve(process.cwd(), rawRoute)

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
  /** Unique username */
  username: string
  /** bcrypt hash of the password */
  passwordHash: string
}

// ─── Repository ───────────────────────────────────────────────────────────────

/**
 * Simple file-based user repository backed by a JSON file.
 *
 * The file is read on every call — suitable for a small number of users
 * managed manually. No caching needed at this scale.
 */
export class UserRepository {
  private readonly filePath: string

  constructor(filePath = USERS_PATH) {
    this.filePath = filePath
  }

  /**
   * Returns all users from the JSON file.
   * Returns an empty array if the file does not exist yet.
   */
  findAll(): User[] {
    if (!fs.existsSync(this.filePath)) return []
    const raw = fs.readFileSync(this.filePath, "utf-8")
    return JSON.parse(raw) as User[]
  }

  /**
   * Finds a user by username (case-insensitive).
   * Returns null if not found.
   */
  findByUsername(username: string): User | null {
    const users = this.findAll()
    return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? null
  }
}