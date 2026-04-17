import pino from "pino"
import path from "path"
import fs from "fs"

const rawLogRoute = process.env["LOG_ROUTE"] ?? "logs"
const LOGS_DIR = path.isAbsolute(rawLogRoute)
  ? rawLogRoute
  : path.join(process.cwd(), rawLogRoute)
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

activityLogger.info({ event: "startup", message: "Logger iniciado" })

// ─── Log helpers ──────────────────────────────────────────────────────────────

/** Logs a successful login. */
export function logLogin(username: string, ip: string): void {
  activityLogger.info({ event: "login", username, ip, message: `${username} inició sesión` })
}

/** Logs a failed login attempt. */
export function logLoginFailed(username: string, ip: string, reason: string): void {
  activityLogger.warn({ event: "login_failed", username, ip, reason, message: `Intento de login fallido para "${username}"` })
}

/** Logs a logout. */
export function logLogout(username: string, ip: string): void {
  activityLogger.info({ event: "logout", username, ip, message: `${username} cerró sesión` })
}

/** Logs an unauthorized access attempt. */
export function logUnauthorized(ip: string, url: string, reason: string): void {
  activityLogger.warn({ event: "unauthorized", ip, url, reason, message: `Acceso no autorizado a ${url}` })
}

// ─── Semantic action logs ─────────────────────────────────────────────────────

/** Logs a CUIT search. */
export function logCuitSearch(username: string, taxId: string, found: boolean): void {
  activityLogger.info({
    event: "cuit_search",
    username,
    taxId,
    found,
    message: `${username} buscó el CUIT ${taxId} — ${found ? "encontrado" : "no encontrado"}`,
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
    message: `${username} buscó camino entre ${from} y ${to} — ${found ? "encontrado" : "no encontrado"}`,
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
    message: `${username} agregó relación ${relationshipType} entre ${fromTaxId} y ${toTaxId}`,
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
    message: `${username} eliminó relación ${relationshipType} entre ${fromTaxId} y ${toTaxId}`,
  })
}

/** Logs a node being viewed. */
export function logNodeViewed(username: string, taxId: string, businessName: string | null): void {
  activityLogger.info({
    event: "node_viewed",
    username,
    taxId,
    businessName,
    message: `${username} consultó el nodo ${taxId}${businessName ? ` (${businessName})` : ""}`,
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
    message: `${username} consultó relaciones de ${taxId} — profundidad ${maxDepth}, ${resultCount} resultados`,
  })
}

/** Logs the base nodes list being viewed. */
export function logMyBaseViewed(username: string, nodeCount: number): void {
  activityLogger.info({
    event: "my_base_viewed",
    username,
    nodeCount,
    message: `${username} consultó su base (${nodeCount} nodos)`,
  })
}

/** Logs the companies list being viewed. */
export function logCompaniesViewed(username: string, nodeCount: number): void {
  activityLogger.info({
    event: "companies_viewed",
    username,
    nodeCount,
    message: `${username} consultó empresas a buscar (${nodeCount} empresas)`,
  })
}

/** Logs a node being updated. */
export function logNodeUpdated(username: string, taxId: string): void {
  activityLogger.info({
    event: "node_updated",
    username,
    taxId,
    message: `${username} editó el nodo ${taxId}`,
  })
}