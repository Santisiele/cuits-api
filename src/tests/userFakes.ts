import type { IPasswordHasher, IUserRepository } from "@ports/interfaces"
import { usernameKey, type Role, type StoredUser } from "@domain/users"
import type { TrustLevelColor } from "@domain/entities"

export class InMemoryUserRepository implements IUserRepository {
  readonly users = new Map<string, StoredUser>()

  constructor(seed: StoredUser[] = []) {
    for (const user of seed) this.users.set(usernameKey(user.username), { ...user })
  }

  async findByUsername(username: string): Promise<StoredUser | null> {
    const user = this.users.get(usernameKey(username))
    return user ? { ...user } : null
  }

  async findAll(): Promise<StoredUser[]> {
    return [...this.users.values()].map((user) => ({ ...user }))
  }

  async create(user: StoredUser): Promise<"created" | "taken"> {
    const key = usernameKey(user.username)
    if (this.users.has(key)) return "taken"
    this.users.set(key, { ...user })
    return "created"
  }

  async update(
    username: string,
    fields: { role?: Role; disabledAt?: string | null; color?: TrustLevelColor | null }
  ): Promise<StoredUser | null> {
    const user = this.users.get(usernameKey(username))
    if (!user) return null
    if (fields.role !== undefined) user.role = fields.role
    if ("disabledAt" in fields) user.disabledAt = fields.disabledAt ?? null
    if ("color" in fields) user.color = fields.color ?? null
    return { ...user }
  }

  async setPasswordHash(username: string, passwordHash: string): Promise<boolean> {
    const user = this.users.get(usernameKey(username))
    if (!user) return false
    user.passwordHash = passwordHash
    return true
  }
}

export const plainHasher: IPasswordHasher = {
  hash: async (password) => `hashed:${password}`,
  compare: async (password, hash) => hash === `hashed:${password}`,
}

export function storedUser(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    username: "santi",
    passwordHash: "hashed:secret123",
    role: "admin",
    createdAt: "2026-09-29T12:00:00.000Z",
    disabledAt: null,
    ...overrides,
  }
}
