import bcrypt from "bcrypt"
import jwt from "jsonwebtoken"
import { config } from "@config.js"
import { UserRepository } from "@auth/UserRepository.js"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoginResult {
  success: true
  token: string
  username: string
}

export interface LoginError {
  success: false
  reason: "invalid_credentials" | "user_not_found"
}

export type AuthResult = LoginResult | LoginError

export interface JwtPayload {
  username: string
  iat: number
  exp: number
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Application service for authentication.
 *
 * Responsibilities:
 * - Validate credentials against the user repository
 * - Issue signed JWT tokens on successful login
 * - Verify JWT tokens for protected routes
 */
export class AuthService {
  private readonly repository: UserRepository

  constructor(repository = new UserRepository()) {
    this.repository = repository
  }

  /**
   * Attempts to log in with the given credentials.
   * Returns a signed JWT on success, or an error reason on failure.
   *
   * @param username - Plain text username
   * @param password - Plain text password (compared against bcrypt hash)
   */
  async login(username: string, password: string): Promise<AuthResult> {
    const user = this.repository.findByUsername(username)

    if (!user) {
      return { success: false, reason: "user_not_found" }
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash)

    if (!passwordValid) {
      return { success: false, reason: "invalid_credentials" }
    }

    const token = jwt.sign(
      { username: user.username },
      config.auth.jwtSecret as string,
      // Cast to `object` to bypass exactOptionalPropertyTypes — jsonwebtoken's
      // SignOptions types include `undefined` in optional fields which conflicts
      // with this setting. The runtime value is always a valid string from config.
      { expiresIn: config.auth.jwtExpiresIn } as object as jwt.SignOptions
    )

    return { success: true, token, username: user.username }
  }

  /**
   * Verifies a JWT token and returns its payload.
   * Throws if the token is invalid or expired.
   *
   * @param token - Raw JWT string (without "Bearer " prefix)
   */
  verify(token: string): JwtPayload {
    return jwt.verify(token, config.auth.jwtSecret) as JwtPayload
  }
}