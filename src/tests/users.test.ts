import { describe, it, expect } from "vitest"
import {
  isRole,
  isSameUser,
  isValidPassword,
  isValidUsername,
  toPublicUser,
  usernameKey,
} from "@domain/users"
import { UserAdminService, UserAdminError } from "@application/UserAdminService"
import { InMemoryUserRepository, plainHasher, storedUser } from "./userFakes"

const NOW = new Date("2026-09-30T10:00:00.000Z")

function service(repository: InMemoryUserRepository) {
  return new UserAdminService(repository, plainHasher, () => NOW)
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    if (err instanceof UserAdminError) return err.reason
    throw err
  }
  throw new Error("expected a rejection")
}

describe("user rules", () => {
  it("accepts only admin and member as roles", () => {
    expect(isRole("admin")).toBe(true)
    expect(isRole("member")).toBe(true)
    expect(isRole("owner")).toBe(false)
    expect(isRole(undefined)).toBe(false)
  })

  it("accepts usernames of 3 to 32 letters, digits, dots, dashes and underscores", () => {
    expect(isValidUsername("diego.f")).toBe(true)
    expect(isValidUsername("tomi_j-2")).toBe(true)
    expect(isValidUsername("ab")).toBe(false)
    expect(isValidUsername("diego f")).toBe(false)
    expect(isValidUsername("a".repeat(33))).toBe(false)
  })

  it("accepts passwords of 8 to 72 bytes", () => {
    expect(isValidPassword("1234567")).toBe(false)
    expect(isValidPassword("12345678")).toBe(true)
    expect(isValidPassword("a".repeat(72))).toBe(true)
    expect(isValidPassword("a".repeat(73))).toBe(false)
    expect(isValidPassword("ñ".repeat(37))).toBe(false)
  })

  it("compares usernames ignoring case and surrounding spaces", () => {
    expect(usernameKey("  Santi ")).toBe("santi")
    expect(isSameUser("Santi", "santi")).toBe(true)
    expect(isSameUser("santi", "luchi")).toBe(false)
  })

  it("never exposes the password hash", () => {
    const user = toPublicUser(storedUser({ disabledAt: NOW.toISOString() }))
    expect(user).toEqual({ username: "santi", role: "admin", createdAt: "2026-09-29T12:00:00.000Z", disabled: true })
  })
})

describe("UserAdminService.create", () => {
  it("hashes the password and stores the user enabled", async () => {
    const repository = new InMemoryUserRepository()
    const user = await service(repository).create(" luchi ", "secret123", "member")

    expect(user).toEqual({ username: "luchi", role: "member", createdAt: NOW.toISOString(), disabled: false })
    expect((await repository.findByUsername("luchi"))?.passwordHash).toBe("hashed:secret123")
  })

  it("rejects a taken username regardless of case", async () => {
    const repository = new InMemoryUserRepository([storedUser()])
    expect(await rejection(service(repository).create("SANTI", "secret123", "member"))).toBe("username_taken")
  })

  it("rejects an invalid username, password or role", async () => {
    const users = service(new InMemoryUserRepository())
    expect(await rejection(users.create("a b", "secret123", "member"))).toBe("invalid_username")
    expect(await rejection(users.create("luchi", "short", "member"))).toBe("invalid_password")
    expect(await rejection(users.create("luchi", "secret123", "owner"))).toBe("invalid_role")
  })
})

describe("UserAdminService.update", () => {
  it("changes the role of another user", async () => {
    const repository = new InMemoryUserRepository([storedUser(), storedUser({ username: "luchi", role: "member" })])
    const user = await service(repository).update("santi", "luchi", { role: "admin" })
    expect(user.role).toBe("admin")
  })

  it("disables and re-enables a user", async () => {
    const repository = new InMemoryUserRepository([storedUser(), storedUser({ username: "luchi", role: "member" })])
    const users = service(repository)

    expect((await users.update("santi", "luchi", { disabled: true })).disabled).toBe(true)
    expect((await repository.findByUsername("luchi"))?.disabledAt).toBe(NOW.toISOString())
    expect((await users.update("santi", "luchi", { disabled: false })).disabled).toBe(false)
  })

  it("keeps the original date when disabling an already disabled user", async () => {
    const repository = new InMemoryUserRepository([
      storedUser(),
      storedUser({ username: "luchi", disabledAt: "2026-01-01T00:00:00.000Z" }),
    ])
    await service(repository).update("santi", "luchi", { disabled: true })
    expect((await repository.findByUsername("luchi"))?.disabledAt).toBe("2026-01-01T00:00:00.000Z")
  })

  it("refuses to let an admin demote or disable themselves", async () => {
    const users = service(new InMemoryUserRepository([storedUser()]))
    expect(await rejection(users.update("Santi", "santi", { role: "member" }))).toBe("cannot_change_self")
    expect(await rejection(users.update("santi", "santi", { disabled: true }))).toBe("cannot_change_self")
  })

  it("lets an admin re-save their own admin role", async () => {
    const users = service(new InMemoryUserRepository([storedUser()]))
    expect((await users.update("santi", "santi", { role: "admin" })).role).toBe("admin")
  })

  it("reports a user deleted between the lookup and the write", async () => {
    const repository = new InMemoryUserRepository([storedUser(), storedUser({ username: "luchi" })])
    repository.update = async () => null
    expect(await rejection(service(repository).update("santi", "luchi", { role: "member" }))).toBe("user_not_found")
  })

  it("rejects an unknown user and invalid changes", async () => {
    const users = service(new InMemoryUserRepository([storedUser()]))
    expect(await rejection(users.update("santi", "nadie", { role: "member" }))).toBe("user_not_found")
    expect(await rejection(users.update("santi", "santi", { role: "owner" }))).toBe("invalid_role")
    expect(await rejection(users.update("santi", "santi", { disabled: "yes" }))).toBe("invalid_disabled")
  })
})

describe("passwords", () => {
  it("resets another user's password", async () => {
    const repository = new InMemoryUserRepository([storedUser({ username: "luchi" })])
    await service(repository).resetPassword("luchi", "nueva1234")
    expect((await repository.findByUsername("luchi"))?.passwordHash).toBe("hashed:nueva1234")
  })

  it("rejects a reset with a short password or an unknown user", async () => {
    const users = service(new InMemoryUserRepository([storedUser()]))
    expect(await rejection(users.resetPassword("santi", "short"))).toBe("invalid_password")
    expect(await rejection(users.resetPassword("nadie", "nueva1234"))).toBe("user_not_found")
  })

  it("changes your own password only with the current one", async () => {
    const repository = new InMemoryUserRepository([storedUser()])
    const users = service(repository)

    expect(await rejection(users.changeOwnPassword("santi", "wrong", "nueva1234"))).toBe("wrong_password")
    expect(await rejection(users.changeOwnPassword("santi", "secret123", "short"))).toBe("invalid_password")
    await users.changeOwnPassword("santi", "secret123", "nueva1234")
    expect((await repository.findByUsername("santi"))?.passwordHash).toBe("hashed:nueva1234")
  })
})

describe("UserAdminService.list", () => {
  it("lists every user without hashes", async () => {
    const users = service(new InMemoryUserRepository([storedUser(), storedUser({ username: "luchi", role: "member" })]))
    const listed = await users.list()
    expect(listed.map((u) => [u.username, u.role])).toEqual([["santi", "admin"], ["luchi", "member"]])
    expect(listed.every((u) => !("passwordHash" in u))).toBe(true)
  })
})
