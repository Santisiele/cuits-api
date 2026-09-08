import pino from "pino"
import path from "path"
import fs from "fs"
import type { OperationSummary, TrustLevelOperationSummary } from "@domain/entities.js"

/**
 * Resolves LOG_ROUTE into an absolute directory path.
 *  - If already absolute (e.g. "/data/logs" in Railway with a mounted volume),
 *    use as-is.
 *  - Otherwise, resolve relative to the project root.
 *
 * IMPORTANT: avoid `path.join(cwd, route)` for absolute routes — `path.join`
 * does NOT preserve absolute paths in the second argument, which would
 * silently route logs into the ephemeral `/app/...` filesystem.
 */
const rawLogRoute = process.env["LOG_ROUTE"] ?? "logs"
const LOGS_DIR = path.isAbsolute(rawLogRoute)
  ? rawLogRoute
  : path.resolve(process.cwd(), rawLogRoute)

const LOG_FILE = path.join(LOGS_DIR, process.env["LOG_DOC"] ?? "activity.log")

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true })
}

console.log("Log file path:", LOG_FILE)

// ─── Activity logger ──────────────────────────────────────────────────────────

/**
 * Dedicated logger for user activity.
 * Writes one JSON line per event to the activity log file.
 */
const activityLogger = pino(
  { level: "info" },
  pino.destination({ dest: LOG_FILE, sync: true })
)

activityLogger.info({ event: "startup", message: "Logger started" })

// ─── Log helpers ──────────────────────────────────────────────────────────────

/** Logs a successful login. */
export function logLogin(username: string, ip: string): void {
  activityLogger.info({ event: "login", username, ip, message: `${username} logged in` })
}

/** Logs a failed login attempt. */
export function logLoginFailed(username: string, ip: string, reason: string): void {
  activityLogger.warn({ event: "login_failed", username, ip, reason, message: `Failed login attempt for "${username}"` })
}

/** Logs a logout. */
export function logLogout(username: string, ip: string): void {
  activityLogger.info({ event: "logout", username, ip, message: `${username} logged out` })
}

/** Logs an unauthorized access attempt. */
export function logUnauthorized(ip: string, url: string, reason: string): void {
  activityLogger.warn({ event: "unauthorized", ip, url, reason, message: `Unauthorized access to ${url}` })
}

// ─── Semantic action logs ─────────────────────────────────────────────────────

/** Logs a CUIT search. */
export function logCuitSearch(username: string, taxId: string, found: boolean): void {
  activityLogger.info({
    event: "cuit_search",
    username,
    taxId,
    found,
    message: `${username} searched CUIT ${taxId} — ${found ? "found" : "not found"}`,
  })
}

/** Logs a search by business name. */
export function logNameSearch(username: string, query: string, resultCount: number): void {
  activityLogger.info({
    event: "name_search",
    username,
    query,
    resultCount,
    message: `${username} searched by name "${query}" — ${resultCount} results`,
  })
}

/** Logs a path search between two CUITs. */
export function logPathSearch(username: string, from: string, to: string, found: boolean): void {
  activityLogger.info({
    event: "path_search",
    username,
    from,
    to,
    found,
    message: `${username} searched for a path between ${from} and ${to} — ${found ? "found" : "not found"}`,
  })
}

/** Logs a relationship being added. */
export function logRelationshipAdded(username: string, fromTaxId: string, toTaxId: string, relationshipType: string): void {
  activityLogger.info({
    event: "relationship_added",
    username,
    fromTaxId,
    toTaxId,
    relationshipType,
    message: `${username} added relationship ${relationshipType} between ${fromTaxId} and ${toTaxId}`,
  })
}

/** Logs a relationship being deleted. */
export function logRelationshipDeleted(username: string, fromTaxId: string, toTaxId: string, relationshipType: string): void {
  activityLogger.info({
    event: "relationship_deleted",
    username,
    fromTaxId,
    toTaxId,
    relationshipType,
    message: `${username} deleted relationship ${relationshipType} between ${fromTaxId} and ${toTaxId}`,
  })
}

/**
 * Logs a node lookup, whether or not the node was there.
 *
 * The route calls this on the 404 path too, with every field null. Saying
 * "viewed CUIT X" for a CUIT that does not exist made the log claim something
 * that never happened, so a miss now reads as a miss.
 */
export function logNodeViewed(
  username: string,
  taxId: string,
  businessName: string | null,
  entryDate: string | null,
  exitDate: string | null,
  loadedAt: string | null,
  found = true
): void {
  activityLogger.info({
    event: "node_viewed",
    username,
    taxId,
    businessName,
    entryDate,
    exitDate,
    loadedAt,
    found,
    message: found
      ? `${username} viewed CUIT ${taxId}` +
        (businessName ? ` (${businessName})` : "") +
        (entryDate ? ` | entry: ${entryDate}` : "") +
        (exitDate ? ` | exit: ${exitDate}` : "") +
        (loadedAt ? ` | loaded: ${loadedAt}` : "")
      : `${username} looked up CUIT ${taxId} — not found`,
  })
}

/** Logs node relationships being viewed. */
export function logNodeRelationshipsViewed(username: string, taxId: string, maxDepth: number, resultCount: number): void {
  activityLogger.info({
    event: "node_relationships_viewed",
    username,
    taxId,
    maxDepth,
    resultCount,
    message: `${username} viewed relationships of ${taxId} — depth ${maxDepth}, ${resultCount} results`,
  })
}

/** Logs the base nodes list being viewed. */
export function logMyBaseViewed(username: string, nodeCount: number): void {
  activityLogger.info({
    event: "my_base_viewed",
    username,
    nodeCount,
    message: `${username} viewed their base (${nodeCount} CUITs)`,
  })
}

/** Logs the companies list being viewed. */
export function logCompaniesViewed(username: string, nodeCount: number): void {
  activityLogger.info({
    event: "companies_viewed",
    username,
    nodeCount,
    message: `${username} viewed companies to look into (${nodeCount} companies)`,
  })
}

/** Logs a node being updated. */
export function logNodeUpdated(username: string, taxId: string): void {
  activityLogger.info({
    event: "node_updated",
    username,
    taxId,
    message: `${username} edited CUIT ${taxId}`,
  })
}

/**
 * Logs a birthday-range query.
 * Mirrors the structure of the other logXxxViewed helpers so audit logs
 * remain uniform across endpoints.
 */
export function logBirthdaysViewed(
  username: string,
  from: string,
  to: string,
  resultCount: number
): void {
  activityLogger.info({
    event: "birthdays_viewed",
    username,
    from,
    to,
    resultCount,
    message: `${username} viewed birthdays between ${from} and ${to} — ${resultCount} results`,
  })
}

/** Logs the to-know nodes list being viewed. */
export function logToKnowViewed(username: string, nodeCount: number): void {
  activityLogger.info({
    event: "to_know_viewed",
    username,
    nodeCount,
    message: `${username} viewed targets (${nodeCount} CUITs)`,
  })
}

/** Logs a crossing-over query, naming the sources that were crossed. */
export function logCrossingViewed(username: string, sources: string[], nodeCount: number): void {
  activityLogger.info({
    event: "crossing_viewed",
    username,
    sources,
    nodeCount,
    message: `${username} crossed ${sources.join(" × ")} (${nodeCount} CUITs)`,
  })
}

/**
 * Logs the full base being viewed, naming the source it was narrowed to.
 *
 * The source is what makes this line worth reading: the endpoint answers one
 * source at a time now, so a log saying only how many CUITs came back cannot
 * tell a look at Poseidon from a look at Bolsa.
 *
 * Null is still possible — the endpoint keeps answering the whole union when
 * asked without a source — and reads differently on purpose.
 */
export function logAllMyNodesViewed(username: string, source: string | null, nodeCount: number): void {
  activityLogger.info({
    event: "all_my_nodes_viewed",
    username,
    source,
    nodeCount,
    message: source
      ? `${username} viewed the full base for "${source}" (${nodeCount} CUITs)`
      : `${username} viewed the full base, every source (${nodeCount} CUITs)`,
  })
}

/**
 * Logs the creation of a new source entity in the graph.
 * Used by the migration script (called once per created source) and
 * by future admin endpoints whenever a source name that didn't exist
 * before shows up.
 */
export function logSourceCreated(
  username: string,
  sourceName: string,
  category: string,
): void {
  activityLogger.info({
    event: "source_created",
    username,
    sourceName,
    category,
    message: `${username} registered source "${sourceName}" (${category})`,
  })
}

// ─── Source admin operations ─────────────────────────────────────────────────

/**
 * Structured log emitted BEFORE every destructive source operation.
 *
 * Initiated and completed events are deliberately separate: if the process
 * dies mid-operation, the orphaned "initiated" line is what tells you which
 * operation was in flight and roughly how much it was about to touch.
 *
 * The affected node list is intentionally NOT logged — on a source with
 * thousands of CUITs it would dwarf the log. Granular reconstruction relies
 * on the Aura snapshot instead.
 */
export function logSourceOperationInitiated(payload: {
  event: string
  username: string
  sourceName: string
  operationParams: Record<string, unknown>
  affectedNodeCount: number
}): void {
  activityLogger.info({
    ...payload,
    timestamp: new Date().toISOString(),
    message: `${payload.username} started "${payload.event}" on "${payload.sourceName}" (~${payload.affectedNodeCount} CUITs)`,
  })
}

/** Structured log emitted after a destructive source operation succeeds. */
export function logSourceOperationCompleted(payload: {
  event: string
  username: string
  sourceName: string
  finalSummary: OperationSummary
  durationMs: number
}): void {
  activityLogger.info({
    ...payload,
    timestamp: new Date().toISOString(),
    message: `${payload.username} finished "${payload.event}" on "${payload.sourceName}" in ${payload.durationMs}ms`,
  })
}

/**
 * Structured log emitted when a destructive source operation throws.
 * `partialProgress` carries whatever the service managed to finish before
 * failing, which is what makes a half-applied batch recoverable by hand.
 */
export function logSourceOperationFailed(payload: {
  event: string
  username: string
  sourceName: string
  error: string
  partialProgress?: Record<string, unknown>
}): void {
  activityLogger.error({
    ...payload,
    timestamp: new Date().toISOString(),
    message: `${payload.username} failed "${payload.event}" on "${payload.sourceName}": ${payload.error}`,
  })
}

/** Logs the trust level list being viewed. */
export function logTrustLevelsViewed(username: string, levelCount: number): void {
  activityLogger.info({
    event: "trust_levels_viewed",
    username,
    levelCount,
    message: `${username} viewed the trust levels (${levelCount} levels)`,
  })
}

/** Logs a trust level being created, renamed, recoloured or deleted. */
export function logTrustLevelOperation(username: string, summary: TrustLevelOperationSummary): void {
  activityLogger.info({
    event: summary.operation.replace("-", "_"),
    username,
    value: summary.value,
    label: summary.label,
    affectedNodeCount: summary.affectedNodeCount,
    message: `${username}: ${summary.message}`,
  })
}
