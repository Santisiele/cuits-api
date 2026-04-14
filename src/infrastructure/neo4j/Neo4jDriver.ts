import neo4j, { type Driver } from "neo4j-driver"
import { config } from "@config.js"

/**
 * Singleton Neo4j driver.
 *
 * A single driver instance manages the connection pool for the entire
 * application lifetime. Creating a new driver per request or per class
 * instance leaks connections and degrades performance.
 *
 * Usage:
 * ```ts
 * const session = Neo4jDriver.instance.session()
 * try { ... } finally { await session.close() }
 * ```
 */
export class Neo4jDriver {
  private static _instance: Driver | null = null

  /** Returns the shared driver instance, creating it on first access. */
  static get instance(): Driver {
    if (!Neo4jDriver._instance) {
      Neo4jDriver._instance = neo4j.driver(
        config.neo4j.uri,
        neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
      )
    }
    return Neo4jDriver._instance
  }

  /**
   * Closes the driver and releases all connections.
   * Call this during graceful shutdown only.
   */
  static async close(): Promise<void> {
    if (Neo4jDriver._instance) {
      await Neo4jDriver._instance.close()
      Neo4jDriver._instance = null
    }
  }

  private constructor() {}
}