import type { IPasswordHasher, IUserRepository } from "@ports/interfaces.js"
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isRole,
  isSameUser,
  isValidPassword,
  isValidUsername,
  toPublicUser,
  type PublicUser,
  type Role,
  type StoredUser,
  type UserRejection,
} from "@domain/users.js"

export class UserAdminError extends Error {
  constructor(readonly reason: UserRejection, message: string) {
    super(message)
    this.name = "UserAdminError"
  }
}

export interface UserChanges {
  role?: unknown
  disabled?: unknown
}

export class UserAdminService {
  constructor(
    private readonly repository: IUserRepository,
    private readonly hasher: IPasswordHasher,
    private readonly now: () => Date = () => new Date()
  ) {}

  async list(): Promise<PublicUser[]> {
    const users = await this.repository.findAll()
    return users.map(toPublicUser)
  }

  async create(username: string, password: string, role: unknown): Promise<PublicUser> {
    const trimmed = username.trim()
    if (!isValidUsername(trimmed)) {
      throw new UserAdminError(
        "invalid_username",
        "Username must be 3 to 32 letters, digits, dots, dashes or underscores"
      )
    }
    this.validatePassword(password)
    if (!isRole(role)) throw new UserAdminError("invalid_role", "Role must be admin or member")

    const user: StoredUser = {
      username: trimmed,
      passwordHash: await this.hasher.hash(password),
      role,
      createdAt: this.now().toISOString(),
      disabledAt: null,
    }
    const outcome = await this.repository.create(user)
    if (outcome === "taken") throw new UserAdminError("username_taken", `User "${trimmed}" already exists`)
    return toPublicUser(user)
  }

  async update(actor: string, username: string, changes: UserChanges): Promise<PublicUser> {
    if (changes.role !== undefined && !isRole(changes.role)) {
      throw new UserAdminError("invalid_role", "Role must be admin or member")
    }
    if (changes.disabled !== undefined && typeof changes.disabled !== "boolean") {
      throw new UserAdminError("invalid_disabled", "disabled must be true or false")
    }
    const role = changes.role as Role | undefined
    const disabled = changes.disabled as boolean | undefined

    const existing = await this.requireUser(username)
    if (isSameUser(actor, existing.username) && (role === "member" || disabled === true)) {
      throw new UserAdminError(
        "cannot_change_self",
        "An admin cannot demote or disable themselves"
      )
    }

    const fields: { role?: Role; disabledAt?: string | null } = {}
    if (role !== undefined) fields.role = role
    if (disabled !== undefined) {
      fields.disabledAt = disabled ? existing.disabledAt ?? this.now().toISOString() : null
    }

    const updated = await this.repository.update(existing.username, fields)
    if (!updated) throw new UserAdminError("user_not_found", `User "${username}" does not exist`)
    return toPublicUser(updated)
  }

  async resetPassword(username: string, password: string): Promise<void> {
    this.validatePassword(password)
    const existing = await this.requireUser(username)
    await this.repository.setPasswordHash(existing.username, await this.hasher.hash(password))
  }

  async changeOwnPassword(username: string, currentPassword: string, newPassword: string): Promise<void> {
    const existing = await this.requireUser(username)
    const matches = await this.hasher.compare(currentPassword, existing.passwordHash)
    if (!matches) throw new UserAdminError("wrong_password", "The current password is wrong")
    this.validatePassword(newPassword)
    await this.repository.setPasswordHash(existing.username, await this.hasher.hash(newPassword))
  }

  private validatePassword(password: string): void {
    if (!isValidPassword(password)) {
      throw new UserAdminError(
        "invalid_password",
        `Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`
      )
    }
  }

  private async requireUser(username: string): Promise<StoredUser> {
    const user = await this.repository.findByUsername(username)
    if (!user) throw new UserAdminError("user_not_found", `User "${username}" does not exist`)
    return user
  }
}
