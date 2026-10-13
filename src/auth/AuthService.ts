import jwt from "jsonwebtoken"
import { config } from "@config.js"
import type { IPasswordHasher, IUserRepository } from "@ports/interfaces.js"
import { Neo4jUserRepository } from "@infrastructure/neo4j/Neo4jUserRepository.js"
import { BcryptPasswordHasher } from "@infrastructure/auth/BcryptPasswordHasher.js"
import { isActive, type Role } from "@domain/users.js"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoginResult {
  success: true
  token: string
  username: string
  role: Role
}

export interface LoginError {
  success: false
  reason: "invalid_credentials" | "user_not_found" | "user_disabled"
}

export type AuthResult = LoginResult | LoginError

export type SessionResult =
  | { valid: true; username: string; role: Role }
  | { valid: false; reason: "invalid_token" | "user_not_found" | "user_disabled" }

export interface JwtPayload {
  username: string
  role: Role
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
  constructor(
    private readonly repository: IUserRepository = new Neo4jUserRepository(),
    private readonly hasher: IPasswordHasher = new BcryptPasswordHasher()
  ) {}

  /**
   * Attempts to log in with the given credentials.
   * Returns a signed JWT on success, or an error reason on failure.
   *
   * @param username - Plain text username
   * @param password - Plain text password (compared against bcrypt hash)
   */
  async login(username: string, password: string): Promise<AuthResult> {
    const user = await this.repository.findByUsername(username)

    if (!user) {
      return { success: false, reason: "user_not_found" }
    }

    const passwordValid = await this.hasher.compare(password, user.passwordHash)

    if (!passwordValid) {
      return { success: false, reason: "invalid_credentials" }
    }

    if (!isActive(user)) {
      return { success: false, reason: "user_disabled" }
    }

    const token = jwt.sign(
      { username: user.username, role: user.role },
      config.auth.jwtSecret as string,
      // Cast to `object` to bypass exactOptionalPropertyTypes — jsonwebtoken's
      // SignOptions types include `undefined` in optional fields which conflicts
      // with this setting. The runtime value is always a valid string from config.
      { expiresIn: config.auth.jwtExpiresIn } as object as jwt.SignOptions
    )

    return { success: true, token, username: user.username, role: user.role }
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

  async resolveSession(token: string): Promise<SessionResult> {
    let payload: JwtPayload
    try {
      payload = this.verify(token)
    } catch {
      return { valid: false, reason: "invalid_token" }
    }
    const user = await this.repository.findByUsername(payload.username)
    if (!user) return { valid: false, reason: "user_not_found" }
    if (!isActive(user)) return { valid: false, reason: "user_disabled" }
    return { valid: true, username: user.username, role: user.role }
  }
}
