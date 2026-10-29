import { isSameUser, usernameKey } from "@domain/users.js"

export const RESPONSIBLE_COLORS = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "slate",
  "sky-300",
  "sky-500",
  "sky-700",
  "blue-300",
  "blue-500",
  "blue-700",
  "blue-900",
  "indigo-300",
  "indigo-500",
  "indigo-700",
  "cyan-500",
  "cyan-700",
] as const

export type ResponsibleColor = (typeof RESPONSIBLE_COLORS)[number]

export const MAX_RESPONSIBLE_NAME_LENGTH = 40

export interface Responsible {
  name: string
  color: ResponsibleColor
  users: string[]
  disabled: boolean
}

export type ResponsibleRejection =
  | "invalid_name"
  | "invalid_color"
  | "invalid_users"
  | "invalid_disabled"
  | "name_taken"
  | "responsible_not_found"
  | "user_not_found"

export function isResponsibleColor(value: unknown): value is ResponsibleColor {
  return typeof value === "string" && (RESPONSIBLE_COLORS as readonly string[]).includes(value)
}

export function cleanResponsibleName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const name = value.trim().replace(/\s+/g, " ")
  return name.length >= 2 && name.length <= MAX_RESPONSIBLE_NAME_LENGTH ? name : null
}

export function responsibleKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase()
}

export function sameResponsible(a: string, b: string): boolean {
  return responsibleKey(a) === responsibleKey(b)
}

export function responsiblesOf(responsibles: readonly Responsible[], username: string): string[] {
  return responsibles
    .filter((responsible) => !responsible.disabled && responsible.users.some((user) => isSameUser(user, username)))
    .map((responsible) => responsible.name)
}

export function ownResponsible(responsibles: readonly Responsible[], username: string): string | null {
  const own = responsibles.find(
    (responsible) => !responsible.disabled && responsible.users.length === 1 && isSameUser(responsible.users[0]!, username)
  )
  return own?.name ?? null
}

export function uniqueUsernames(values: unknown): string[] | null {
  if (values === undefined || values === null) return []
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) return null
  const seen = new Map<string, string>()
  for (const value of values as string[]) {
    const trimmed = value.trim()
    if (trimmed && !seen.has(usernameKey(trimmed))) seen.set(usernameKey(trimmed), trimmed)
  }
  return [...seen.values()]
}
