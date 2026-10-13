import { describe, it, expect } from "vitest"
import {
  canAdminister,
  hasCreator,
  isAssignableRole,
  isCreator,
  isRole,
  isSameUser,
  isValidPassword,
  isValidUsername,
  toPublicUser,
  userChangeRejection,
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
  it("knows the creator, admin and member roles", () => {
    expect(isRole("creator")).toBe(true)
    expect(isRole("admin")).toBe(true)
    expect(isRole("member")).toBe(true)
    expect(isRole("owner")).toBe(false)
    expect(isRole(undefined)).toBe(false)
  })

  it("assigns only admin and member, never creator", () => {
    expect(isAssignableRole("admin")).toBe(true)
    expect(isAssignableRole("member")).toBe(true)
    expect(isAssignableRole("creator")).toBe(false)
    expect(isAssignableRole(undefined)).toBe(false)
  })

  it("lets the creator and admins administer", () => {
    expect(canAdminister("creator")).toBe(true)
    expect(canAdminister("admin")).toBe(true)
    expect(canAdminister("member")).toBe(false)
  })

  it("tells the creator apart from everyone else", () => {
    expect(isCreator("creator")).toBe(true)
    expect(isCreator("admin")).toBe(false)
    expect(isCreator("member")).toBe(false)
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
    expect(await rejection(users.create("luchi", "secret123", "creator"))).toBe("invalid_role")
  })
})

function team() {
  return new InMemoryUserRepository([
    storedUser({ username: "sofi", role: "creator" }),
    storedUser({ username: "santi", role: "admin" }),
    storedUser({ username: "diego", role: "admin" }),
    storedUser({ username: "luchi", role: "member" }),
  ])
}

describe("who can change whom", () => {
  it("nobody changes the creator", () => {
    expect(userChangeRejection("creator", "creator")).toBe("cannot_change_creator")
    expect(userChangeRejection("admin", "creator")).toBe("cannot_change_creator")
  })

  it("only the creator changes an admin", () => {
    expect(userChangeRejection("creator", "admin")).toBeNull()
    expect(userChangeRejection("admin", "admin")).toBe("creator_only")
  })

  it("the creator and admins change a member", () => {
    expect(userChangeRejection("creator", "member")).toBeNull()
    expect(userChangeRejection("admin", "member")).toBeNull()
  })
})

describe("UserAdminService.createAnyRole", () => {
  it("creates the creator when there is none", async () => {
    const repository = new InMemoryUserRepository([storedUser()])
    const user = await service(repository).createAnyRole("sofi", "secret123", "creator")
    expect(user.role).toBe("creator")
    expect((await repository.findByUsername("sofi"))?.passwordHash).toBe("hashed:secret123")
  })

  it("refuses a second creator", async () => {
    const repository = team()
    expect(await rejection(service(repository).createAnyRole("otra", "secret123", "creator"))).toBe("creator_exists")
    expect(await repository.findByUsername("otra")).toBeNull()
  })

  it("creates admins and members even with a creator around", async () => {
    const users = service(team())
    expect((await users.createAnyRole("flavia", "secret123", "admin")).role).toBe("admin")
    expect((await users.createAnyRole("tomi", "secret123", "member")).role).toBe("member")
  })

  it("rejects an unknown role and bad credentials", async () => {
    const users = service(new InMemoryUserRepository())
    expect(await rejection(users.createAnyRole("flavia", "secret123", "owner"))).toBe("invalid_role")
    expect(await rejection(users.createAnyRole("a b", "secret123", "member"))).toBe("invalid_username")
    expect(await rejection(users.createAnyRole("flavia", "short", "member"))).toBe("invalid_password")
  })

  it("tells whether a creator exists", () => {
    expect(hasCreator([storedUser()])).toBe(false)
    expect(hasCreator([storedUser(), storedUser({ username: "sofi", role: "creator" })])).toBe(true)
  })
})

describe("UserAdminService.update", () => {
  it("lets the creator and admins promote a member", async () => {
    for (const actor of ["creator", "admin"] as const) {
      const repository = team()
      expect((await service(repository).update(actor, "luchi", { role: "admin" })).role).toBe("admin")
    }
  })

  it("lets only the creator demote an admin", async () => {
    const repository = team()
    expect(await rejection(service(repository).update("admin", "diego", { role: "member" }))).toBe("creator_only")
    expect((await repository.findByUsername("diego"))?.role).toBe("admin")
    expect((await service(repository).update("creator", "diego", { role: "member" })).role).toBe("member")
  })

  it("lets the creator and admins disable and re-enable a member", async () => {
    for (const actor of ["creator", "admin"] as const) {
      const repository = team()
      const users = service(repository)
      expect((await users.update(actor, "luchi", { disabled: true })).disabled).toBe(true)
      expect((await repository.findByUsername("luchi"))?.disabledAt).toBe(NOW.toISOString())
      expect((await users.update(actor, "luchi", { disabled: false })).disabled).toBe(false)
    }
  })

  it("lets only the creator disable or enable an admin", async () => {
    const repository = team()
    expect(await rejection(service(repository).update("admin", "diego", { disabled: true }))).toBe("creator_only")
    expect((await service(repository).update("creator", "diego", { disabled: true })).disabled).toBe(true)
  })

  it("stops an admin from changing themselves", async () => {
    const users = service(team())
    expect(await rejection(users.update("admin", "Santi", { role: "member" }))).toBe("creator_only")
    expect(await rejection(users.update("admin", "santi", { disabled: true }))).toBe("creator_only")
  })

  it("never changes the creator, not even by the creator", async () => {
    const users = service(team())
    expect(await rejection(users.update("creator", "sofi", { disabled: true }))).toBe("cannot_change_creator")
    expect(await rejection(users.update("admin", "sofi", { role: "member" }))).toBe("cannot_change_creator")
  })

  it("keeps the original date when disabling an already disabled user", async () => {
    const repository = new InMemoryUserRepository([
      storedUser({ username: "luchi", role: "member", disabledAt: "2026-01-01T00:00:00.000Z" }),
    ])
    await service(repository).update("admin", "luchi", { disabled: true })
    expect((await repository.findByUsername("luchi"))?.disabledAt).toBe("2026-01-01T00:00:00.000Z")
  })

  it("reports a user deleted between the lookup and the write", async () => {
    const repository = team()
    repository.update = async () => null
    expect(await rejection(service(repository).update("admin", "luchi", { role: "admin" }))).toBe("user_not_found")
  })

  it("rejects an unknown user and invalid changes", async () => {
    const users = service(team())
    expect(await rejection(users.update("admin", "nadie", { role: "member" }))).toBe("user_not_found")
    expect(await rejection(users.update("admin", "luchi", { role: "owner" }))).toBe("invalid_role")
    expect(await rejection(users.update("creator", "luchi", { role: "creator" }))).toBe("invalid_role")
    expect(await rejection(users.update("admin", "luchi", { disabled: "yes" }))).toBe("invalid_disabled")
  })
})

describe("passwords", () => {
  it("lets the creator and admins reset a member's password", async () => {
    for (const actor of ["creator", "admin"] as const) {
      const repository = team()
      await service(repository).resetPassword(actor, "luchi", "nueva1234")
      expect((await repository.findByUsername("luchi"))?.passwordHash).toBe("hashed:nueva1234")
    }
  })

  it("lets only the creator reset an admin's password", async () => {
    const repository = team()
    expect(await rejection(service(repository).resetPassword("admin", "diego", "nueva1234"))).toBe("creator_only")
    expect((await repository.findByUsername("diego"))?.passwordHash).toBe("hashed:secret123")
    await service(repository).resetPassword("creator", "diego", "nueva1234")
    expect((await repository.findByUsername("diego"))?.passwordHash).toBe("hashed:nueva1234")
  })

  it("never resets the creator's password", async () => {
    const users = service(team())
    expect(await rejection(users.resetPassword("creator", "sofi", "nueva1234"))).toBe("cannot_change_creator")
    expect(await rejection(users.resetPassword("admin", "sofi", "nueva1234"))).toBe("cannot_change_creator")
  })

  it("rejects a reset with a short password or an unknown user", async () => {
    const users = service(team())
    expect(await rejection(users.resetPassword("admin", "luchi", "short"))).toBe("invalid_password")
    expect(await rejection(users.resetPassword("admin", "nadie", "nueva1234"))).toBe("user_not_found")
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
