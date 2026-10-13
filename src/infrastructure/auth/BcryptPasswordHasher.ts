import bcrypt from "bcrypt"
import type { IPasswordHasher } from "@ports/interfaces.js"

const SALT_ROUNDS = 12

export class BcryptPasswordHasher implements IPasswordHasher {
  hash(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS)
  }

  compare(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash)
  }
}
