export const ROLES = ["creator", "admin", "member"] as const

export type Role = (typeof ROLES)[number]

export const ASSIGNABLE_ROLES = ["admin", "member"] as const

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

export interface StoredUser {
  username: string
  passwordHash: string
  role: Role
  createdAt: string
  disabledAt: string | null
}

export interface PublicUser {
  username: string
  role: Role
  createdAt: string
  disabled: boolean
}

export type UserRejection =
  | "invalid_username"
  | "invalid_password"
  | "invalid_role"
  | "invalid_disabled"
  | "username_taken"
  | "user_not_found"
  | "wrong_password"
  | "cannot_change_creator"
  | "creator_only"

export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 72

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value)
}

export function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(value)
}

export function canAdminister(role: Role): boolean {
  return role === "creator" || role === "admin"
}

export function userChangeRejection(
  actorRole: Role,
  targetRole: Role
): "cannot_change_creator" | "creator_only" | null {
  if (targetRole === "creator") return "cannot_change_creator"
  if (targetRole === "admin" && actorRole !== "creator") return "creator_only"
  return null
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username)
}

export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_LENGTH
}

export function usernameKey(username: string): string {
  return username.trim().toLowerCase()
}

export function isSameUser(a: string, b: string): boolean {
  return usernameKey(a) === usernameKey(b)
}

export function isActive(user: StoredUser): boolean {
  return user.disabledAt === null
}

export function toPublicUser(user: StoredUser): PublicUser {
  return {
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    disabled: !isActive(user),
  }
}
