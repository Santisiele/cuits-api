import type { IPasswordHasher, IUserRepository } from "@ports/interfaces.js"
import { isTrustLevelColor, type TrustLevelColor } from "@domain/entities.js"
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hasCreator,
  isAssignableRole,
  isRole,
  isValidPassword,
  isValidUsername,
  toPublicUser,
  userChangeRejection,
  type AssignableRole,
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
  color?: unknown
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
    const trimmed = this.validateCredentials(username, password)
    if (!isAssignableRole(role)) throw new UserAdminError("invalid_role", "Role must be admin or member")
    return this.store(trimmed, password, role)
  }

  async createAnyRole(username: string, password: string, role: unknown): Promise<PublicUser> {
    const trimmed = this.validateCredentials(username, password)
    if (!isRole(role)) throw new UserAdminError("invalid_role", "Role must be creator, admin or member")
    if (role === "creator" && hasCreator(await this.repository.findAll())) {
      throw new UserAdminError("creator_exists", "There is already a creator")
    }
    return this.store(trimmed, password, role)
  }

  private validateCredentials(username: string, password: string): string {
    const trimmed = username.trim()
    if (!isValidUsername(trimmed)) {
      throw new UserAdminError(
        "invalid_username",
        "Username must be 3 to 32 letters, digits, dots, dashes or underscores"
      )
    }
    this.validatePassword(password)
    return trimmed
  }

  private async store(trimmed: string, password: string, role: Role): Promise<PublicUser> {
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

  async update(actorRole: Role, username: string, changes: UserChanges): Promise<PublicUser> {
    if (changes.role !== undefined && !isAssignableRole(changes.role)) {
      throw new UserAdminError("invalid_role", "Role must be admin or member")
    }
    if (changes.disabled !== undefined && typeof changes.disabled !== "boolean") {
      throw new UserAdminError("invalid_disabled", "disabled must be true or false")
    }
    if (changes.color !== undefined && changes.color !== null && !isTrustLevelColor(changes.color)) {
      throw new UserAdminError("invalid_color", "That color is not available")
    }
    const role = changes.role as AssignableRole | undefined
    const disabled = changes.disabled as boolean | undefined
    const onlyColor = role === undefined && disabled === undefined

    const existing = onlyColor ? await this.requireUser(username) : await this.requireChangeableUser(actorRole, username)

    const fields: { role?: Role; disabledAt?: string | null; color?: TrustLevelColor | null } = {}
    if (changes.color !== undefined) fields.color = changes.color as TrustLevelColor | null
    if (role !== undefined) fields.role = role
    if (disabled !== undefined) {
      fields.disabledAt = disabled ? existing.disabledAt ?? this.now().toISOString() : null
    }

    const updated = await this.repository.update(existing.username, fields)
    if (!updated) throw new UserAdminError("user_not_found", `User "${username}" does not exist`)
    return toPublicUser(updated)
  }

  async resetPassword(actorRole: Role, username: string, password: string): Promise<void> {
    this.validatePassword(password)
    const existing = await this.requireChangeableUser(actorRole, username)
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

  private async requireChangeableUser(actorRole: Role, username: string): Promise<StoredUser> {
    const user = await this.requireUser(username)
    const rejection = userChangeRejection(actorRole, user.role)
    if (rejection === "cannot_change_creator") {
      throw new UserAdminError(rejection, "Nobody can change the creator through the API")
    }
    if (rejection === "creator_only") {
      throw new UserAdminError(rejection, "Only the creator can change an admin")
    }
    return user
  }

  private async requireUser(username: string): Promise<StoredUser> {
    const user = await this.repository.findByUsername(username)
    if (!user) throw new UserAdminError("user_not_found", `User "${username}" does not exist`)
    return user
  }
}
