import bcrypt from "bcrypt"
import { UserRepository } from "@auth/UserRepository.js"

/**
 * Raised when step-up authentication fails. Carries no detail about
 * WHY it failed on purpose: route handlers turn every instance into the
 * same 401, so a caller can't use the endpoint to probe which usernames
 * exist.
 */
export class PasswordVerificationError extends Error {
  constructor(message = "Password verification failed") {
    super(message)
    this.name = "PasswordVerificationError"
  }
}

const userRepository = new UserRepository()

/**
 * Verifies that a password matches the currently-authenticated user's
 * stored credentials. Used as "step-up authentication" before executing
 * destructive operations, where a valid JWT alone is not enough.
 *
 * Current strategy (A1): password only, taking the username from the
 * verified token. Evolving to A2 (username + password) or to a temporary
 * confirmation token means changing this function alone — callers pass a
 * shape that stays stable.
 *
 * @throws PasswordVerificationError when the user is unknown or the
 *         password does not match.
 */
export async function verifyUserPassword(
  username: string,
  password: string,
): Promise<void> {
  const user = userRepository.findByUsername(username)
  if (!user) throw new PasswordVerificationError("User not found")

  const isValid = await bcrypt.compare(password, user.passwordHash)
  if (!isValid) throw new PasswordVerificationError("Invalid password")
}
