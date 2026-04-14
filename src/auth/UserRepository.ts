import fs from "fs"
import path from "path"

const USERS_PATH = path.join(process.cwd(), process.env["DATA_ROUTE"] ?? "")

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
 * Uses process.cwd() to resolve the path relative to the project root,
 * regardless of where the compiled file ends up.
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