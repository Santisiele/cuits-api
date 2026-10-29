import type { IResponsibleRepository } from "@ports/interfaces.js"
import {
  cleanResponsibleName,
  isResponsibleColor,
  sameResponsible,
  uniqueUsernames,
  type Responsible,
  type ResponsibleRejection,
} from "@domain/responsibles.js"
import { isSameUser } from "@domain/users.js"

export class ResponsibleError extends Error {
  constructor(readonly reason: ResponsibleRejection, message: string) {
    super(message)
    this.name = "ResponsibleError"
  }
}

const MESSAGES: Record<ResponsibleRejection, string> = {
  invalid_name: "The name must be 2 to 40 characters",
  invalid_color: "That color is not available",
  invalid_users: "The linked users must be a list of usernames",
  name_taken: "Another responsible already has that name",
  responsible_not_found: "That responsible does not exist",
  user_not_found: "That user does not exist",
}

interface ResponsibleBody {
  name?: unknown
  color?: unknown
  users?: unknown
  disabled?: unknown
}

export class ResponsibleService {
  constructor(
    private readonly repository: IResponsibleRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  list(): Promise<Responsible[]> {
    return this.repository.listResponsibles()
  }

  async create(body: ResponsibleBody, by: string): Promise<Responsible> {
    const responsible: Responsible = {
      name: this.requireName(body.name),
      color: this.requireColor(body.color),
      users: await this.requireUsers(body.users),
      disabled: false,
    }
    if ((await this.repository.createResponsible(responsible, this.now().toISOString(), by)) === "taken") this.fail("name_taken")
    return responsible
  }

  async update(name: string, body: ResponsibleBody): Promise<Responsible> {
    const existing = (await this.repository.listResponsibles()).find((responsible) => sameResponsible(responsible.name, name))
    if (!existing) this.fail("responsible_not_found")
    if (body.disabled !== undefined && typeof body.disabled !== "boolean") this.fail("invalid_users")
    const updated: Responsible = {
      name: body.name === undefined ? existing.name : this.requireName(body.name),
      color: body.color === undefined ? existing.color : this.requireColor(body.color),
      users: body.users === undefined ? existing.users : await this.requireUsers(body.users),
      disabled: body.disabled === undefined ? existing.disabled : (body.disabled as boolean),
    }
    if ((await this.repository.updateResponsible(existing.name, updated)) === "taken") this.fail("name_taken")
    return updated
  }

  private requireName(value: unknown): string {
    const name = cleanResponsibleName(value)
    if (name === null) this.fail("invalid_name")
    return name
  }

  private requireColor(value: unknown) {
    if (!isResponsibleColor(value)) this.fail("invalid_color")
    return value
  }

  private async requireUsers(value: unknown): Promise<string[]> {
    const usernames = uniqueUsernames(value)
    if (usernames === null) this.fail("invalid_users")
    const active = await this.repository.listActiveUsers()
    return usernames.map((username) => {
      const match = active.find((user) => isSameUser(user.username, username))
      if (!match) this.fail("user_not_found")
      return match.username
    })
  }

  private fail(reason: ResponsibleRejection): never {
    throw new ResponsibleError(reason, MESSAGES[reason])
  }
}
