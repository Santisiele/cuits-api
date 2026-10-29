import type { Session } from "neo4j-driver"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import type { IUserRepository } from "@ports/interfaces.js"
import { isRole, usernameKey, type Role, type StoredUser } from "@domain/users.js"
import { isTrustLevelColor, type TrustLevelColor } from "@domain/entities.js"

function toStoredUser(properties: Record<string, unknown>): StoredUser {
  const role = properties["role"]
  const disabledAt = properties["disabledAt"]
  return {
    username: String(properties["username"] ?? ""),
    passwordHash: String(properties["passwordHash"] ?? ""),
    role: isRole(role) ? role : "member",
    createdAt: String(properties["createdAt"] ?? ""),
    disabledAt: typeof disabledAt === "string" && disabledAt !== "" ? disabledAt : null,
    color: isTrustLevelColor(properties["color"]) ? properties["color"] : null,
  }
}

export class Neo4jUserRepository implements IUserRepository {
  private constraintEnsured = false

  private session(): Session {
    return Neo4jDriver.instance.session()
  }

  async ensureConstraint(): Promise<void> {
    if (this.constraintEnsured) return
    const session = this.session()
    try {
      await session.run(Queries.CREATE_USER_CONSTRAINT)
      this.constraintEnsured = true
    } finally {
      await session.close()
    }
  }

  async findByUsername(username: string): Promise<StoredUser | null> {
    const session = this.session()
    try {
      const result = await session.run(Queries.FIND_USER, { key: usernameKey(username) })
      const record = result.records[0]
      return record ? toStoredUser(record.get("u").properties) : null
    } finally {
      await session.close()
    }
  }

  async findAll(): Promise<StoredUser[]> {
    const session = this.session()
    try {
      const result = await session.run(Queries.FIND_ALL_USERS)
      return result.records.map((record) => toStoredUser(record.get("u").properties))
    } finally {
      await session.close()
    }
  }

  async create(user: StoredUser): Promise<"created" | "taken"> {
    await this.ensureConstraint()
    const session = this.session()
    try {
      const result = await session.run(Queries.CREATE_USER, {
        key: usernameKey(user.username),
        username: user.username,
        passwordHash: user.passwordHash,
        role: user.role,
        createdAt: user.createdAt,
        disabledAt: user.disabledAt,
      })
      return result.records.length > 0 ? "created" : "taken"
    } catch (err) {
      if (String((err as { code?: unknown }).code ?? "").includes("ConstraintValidationFailed")) return "taken"
      throw err
    } finally {
      await session.close()
    }
  }

  async update(
    username: string,
    fields: { role?: Role; disabledAt?: string | null; color?: TrustLevelColor | null }
  ): Promise<StoredUser | null> {
    const session = this.session()
    try {
      const result = await session.run(Queries.UPDATE_USER, {
        key: usernameKey(username),
        setRole: fields.role !== undefined,
        role: fields.role ?? null,
        setDisabledAt: "disabledAt" in fields,
        disabledAt: fields.disabledAt ?? null,
        setColor: "color" in fields,
        color: fields.color ?? null,
      })
      const record = result.records[0]
      return record ? toStoredUser(record.get("u").properties) : null
    } finally {
      await session.close()
    }
  }

  async setPasswordHash(username: string, passwordHash: string): Promise<boolean> {
    const session = this.session()
    try {
      const result = await session.run(Queries.SET_USER_PASSWORD_HASH, {
        key: usernameKey(username),
        passwordHash,
      })
      return result.records.length > 0
    } finally {
      await session.close()
    }
  }
}
