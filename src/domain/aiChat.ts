import type { ResearchSource, ResearchUsage } from "@domain/webResearch.js"

export type ChatMessageRole = "user" | "assistant"

export type ChatMessageStatus = "running" | "done" | "failed" | "budget_exhausted"

export type AiChatRejection =
  | "invalid_question"
  | "chat_not_found"
  | "message_not_found"
  | "chat_busy"
  | "budget_exhausted"
  | "research_off"

export interface ChatTable {
  resultId: string
  title: string
  columns: string[]
  rows: unknown[][]
  truncated: boolean
}

export interface AiChat {
  id: string
  title: string
  createdBy: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface AiChatMessage {
  id: string
  chatId: string
  role: ChatMessageRole
  createdAt: string
  text: string
  sources: ResearchSource[]
  tables: ChatTable[]
  status: ChatMessageStatus
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  webSearches: number
  costUsd: number
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  truncated: boolean
}

export interface ToolOutcome {
  content: string
  isError: boolean
}

export interface ChatHistoryEntry {
  role: ChatMessageRole
  text: string
}

export interface ChatAnswer {
  text: string
  sources: ResearchSource[]
  model: string
  usage: ResearchUsage
  stoppedForBudget: boolean
}

export interface ChatTurn {
  history: ChatHistoryEntry[]
  question: string
  executeTool: (name: string, input: unknown) => Promise<ToolOutcome>
  afterRound: (usage: ResearchUsage, model: string) => Promise<boolean>
}

export class AssistantError extends Error {
  constructor(message: string, readonly usage: ResearchUsage, readonly model: string) {
    super(message)
    this.name = "AssistantError"
  }
}

export const MAX_QUESTION_LENGTH = 4000
export const MAX_HISTORY_MESSAGES = 30
export const ROWS_FOR_MODEL = 200
export const ROWS_STORED = 5000
export const QUERY_TIMEOUT_MS = 15_000
export const TITLE_LENGTH = 80

const MAX_CYPHER_LENGTH = 8000
const MODEL_STRING_LIMIT = 500
const STORED_STRING_LIMIT = 5000

export const HIDDEN_LABELS = [
  "User",
  "AiBudget",
  "AiChat",
  "AiChatMessage",
  "Backup",
  "BackupRestore",
  "KeepAlive",
  "BirthdaySweep",
] as const

const HIDDEN_PROPERTY = /hash|password|token|secret|passphrase/i

const ALLOWED_PROCEDURES = new Set([
  "db.labels",
  "db.relationshipTypes",
  "db.propertyKeys",
  "db.schema.nodeTypeProperties",
  "db.schema.relTypeProperties",
])

const WRITE_KEYWORDS =
  /(?<![.$\w])(CREATE|INSERT|MERGE|SET|DELETE|DETACH|NODETACH|REMOVE|DROP|FOREACH|LOAD|USE|GRANT|DENY|REVOKE|ALTER|RENAME|START|STOP|TERMINATE|SHOW|ENABLE|DISABLE)\b/i

const FORBIDDEN_NAMESPACES = /\b(apoc|dbms|gds|genai)\s*\./i

const HIDDEN_LABEL_PATTERN = new RegExp(`:\\s*\`?(${HIDDEN_LABELS.join("|")})\`?(?![\\w])`, "i")

export function normaliseQuestion(value: unknown): string | null {
  if (typeof value !== "string") return null
  const question = value.trim()
  return question === "" || question.length > MAX_QUESTION_LENGTH ? null : question
}

export function chatTitle(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim()
  return flat.length <= TITLE_LENGTH ? flat : `${flat.slice(0, TITLE_LENGTH - 1)}…`
}

function withoutStringsAndComments(cypher: string): string {
  return cypher
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
}

export function cypherRejection(cypher: unknown): string | null {
  if (typeof cypher !== "string" || cypher.trim() === "") return "The query is empty"
  if (cypher.length > MAX_CYPHER_LENGTH) return `The query is longer than ${MAX_CYPHER_LENGTH} characters`
  const code = withoutStringsAndComments(cypher)
  if (code.replace(/;\s*$/, "").includes(";")) return "Only one statement per query"
  if (HIDDEN_LABEL_PATTERN.test(code)) return "That label is not available"
  const bare = code.replace(/`[^`]*`/g, "``")
  const write = WRITE_KEYWORDS.exec(bare)
  if (write) return `Only read queries are allowed (found ${write[1]?.toUpperCase()})`
  if (FORBIDDEN_NAMESPACES.test(bare)) return "Procedures and functions from that namespace are not allowed"
  for (const match of bare.matchAll(/\bCALL\s+([A-Za-z_][\w.]*)/gi)) {
    if (!ALLOWED_PROCEDURES.has(match[1] ?? "")) return `The procedure ${match[1]} is not allowed`
  }
  return null
}

function isHiddenEntity(value: Record<string, unknown>): boolean {
  const labels = value["_labels"]
  return Array.isArray(labels) && labels.some((label) => (HIDDEN_LABELS as readonly string[]).includes(String(label)))
}

export function hideSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hideSecrets)
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  if (isHiddenEntity(record)) return null
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !HIDDEN_PROPERTY.test(key))
      .map(([key, inner]) => [key, hideSecrets(inner)])
  )
}

export function visibleColumns(columns: readonly string[]): number[] {
  return columns.flatMap((column, index) => (HIDDEN_PROPERTY.test(column) ? [] : [index]))
}

export function hideResult(result: QueryResult): QueryResult {
  const keep = visibleColumns(result.columns)
  return {
    columns: keep.map((index) => result.columns[index] ?? ""),
    rows: result.rows.map((row) => keep.map((index) => hideSecrets(row[index]))),
    truncated: result.truncated,
  }
}

function cutStrings(value: unknown, limit: number): unknown {
  if (typeof value === "string") return value.length <= limit ? value : `${value.slice(0, limit)}… [${value.length - limit} more characters]`
  if (Array.isArray(value)) return value.map((inner) => cutStrings(inner, limit))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, cutStrings(inner, limit)]))
}

export function rowsForModel(rows: readonly unknown[][]): unknown[][] {
  return rows.slice(0, ROWS_FOR_MODEL).map((row) => row.map((value) => cutStrings(value, MODEL_STRING_LIMIT)))
}

export function rowsForStorage(rows: readonly unknown[][]): unknown[][] {
  return rows.slice(0, ROWS_STORED).map((row) => row.map((value) => cutStrings(value, STORED_STRING_LIMIT)))
}

export function describeResult(resultId: string, result: QueryResult, offset = 0): string {
  const page = rowsForModel(result.rows.slice(offset))
  const total = result.rows.length
  return JSON.stringify({
    resultId,
    columns: result.columns,
    rowCount: total,
    moreRowsInDatabase: result.truncated,
    offset,
    rows: page,
    note:
      offset + page.length < total
        ? `Showing rows ${offset + 1}-${offset + page.length} of ${total}. Use get_table with a higher offset for the rest.`
        : undefined,
  })
}

export function tableNote(table: ChatTable): string {
  return `[Listado ${table.resultId}: "${table.title}", ${table.rows.length} filas${table.truncated ? " (cortado)" : ""}, columnas ${table.columns.join(", ")}]`
}

export function historyFrom(messages: readonly AiChatMessage[]): ChatHistoryEntry[] {
  const entries = messages
    .filter((message) => message.status !== "running")
    .map((message): ChatHistoryEntry => {
      if (message.role === "user") return { role: "user", text: message.text }
      const notes = message.tables.map(tableNote)
      const text = [message.text.trim() || "(No llegué a completar esta respuesta.)", ...notes].join("\n\n")
      return { role: "assistant", text }
    })
  const recent = entries.slice(-MAX_HISTORY_MESSAGES)
  return recent[0]?.role === "assistant" ? recent.slice(1) : recent
}

export function emptyUsage(): ResearchUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 }
}

export const CHAT_TOOLS = [
  {
    name: "run_query",
    description:
      "Runs a read-only Cypher query against the Neo4j database and returns a resultId, the columns and the first rows. Write clauses are rejected.",
    input_schema: {
      type: "object" as const,
      properties: {
        cypher: { type: "string", description: "A single read-only Cypher statement" },
        params: { type: "object", description: "Query parameters, referenced as $name in the query" },
      },
      required: ["cypher"],
    },
  },
  {
    name: "show_table",
    description:
      "Shows the full result of a previous query to the user as a downloadable table. Use it for every list the user asked for.",
    input_schema: {
      type: "object" as const,
      properties: {
        resultId: { type: "string" },
        title: { type: "string", description: "A short title in Spanish" },
      },
      required: ["resultId", "title"],
    },
  },
  {
    name: "get_table",
    description: "Reads more rows of a previous query result or of a table shown earlier in this conversation.",
    input_schema: {
      type: "object" as const,
      properties: {
        resultId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["resultId"],
    },
  },
]

export const CHAT_SYSTEM_PROMPT = `Sos un asistente de análisis comercial. Respondés preguntas sobre una base de datos de personas y empresas de Argentina (Neo4j) y armás listados. Si te lo piden, completás con información pública de la web.

## Cómo trabajar
- Usá la base primero, con la herramienta run_query (Cypher de solo lectura). Si una consulta falla, corregila y reintentá.
- Para devolver un listado, llamá a show_table con el resultId de la consulta. No copies la tabla en el texto: el usuario la ve aparte y la puede descargar.
- Pedí columnas concretas (c.id AS cuit, c.businessName AS nombre…) en lugar de nodos enteros.
- Si la pregunta es ambigua (fechas, qué cuenta como "cliente"), decí qué interpretaste.
- Usá la web (web_search, web_fetch) solo si te lo piden o si hace falta para completar lo pedido. Todo dato de la web lleva su fuente y va separado de lo que dice la base.
- Buscá solo información comercial y profesional: actividad, cargos, sociedades, Boletín Oficial, concursos, juicios. Nada de vida personal.
- Respondé siempre en español y en Markdown, solo con la respuesta final, sin narrar lo que vas a hacer.

## Esquema de la base
(:CUIT) — una persona o empresa. Propiedades:
- id: el CUIT, 11 dígitos como texto. Empieza con 20, 23, 24, 27 → persona; 30, 33, 34 → empresa.
- businessName: nombre o razón social. Para buscar por nombre usá toLower(c.businessName) CONTAINS toLower('texto').
- inMyBase: true si está en alguna fuente cargada (false = solo apareció como relacionado de otro).
- isKnown: true si está en una fuente "conocidos" (clientes, conocidos de los directivos, etc.).
- isToKnow: true si está en una fuente "por conocer" (bolsa, deudores, concursadas…).
- sources: lista con los nombres de sus fuentes.
- levelOfTrust (número, 0 = sin nivel) y trustReason. El nombre del nivel está en (:TrustLevel {value, label, description}).
- phone, email, birthday (dd/mm/aaaa), city, segment, owner, mainContact, shortName.
- bolsaOperations: JSON en texto, lista de {date "01/mm/aaaa", amount, responsibleTaxId, responsibleName, alycSeller}.
- financieraOperations: JSON en texto, lista de {entityName (financiera), date "01/mm/aaaa", situation (1 a 5, situación BCRA), totalLoan (pesos)}.
- bankOperations: igual que financieraOperations, pero de bancos.
- Datos de CRM: crmCompany (true si es empresa del CRM), crmProduct, crmBrand, crmOrigin, crmAddedAt, crmClosedAt, crmClosedReason.

(:Source {name, category}) — una fuente cargada. category es "known" (conocidos) o "toKnow" (por conocer). (:CUIT)-[:HAS_SOURCE]->(:Source).

(:CUIT)-[:RELATED_TO {type}]->(:CUIT) — relaciones de Nosis. Las más comunes son Employer, Check Signer, Director, President, Deputy Director, Partner, Vice President, Manager, Employee, Linked Company, Auditor, Shareholder, Spouse, Parent, Child, y las "Former ...". En general (a)-[:RELATED_TO {type: "President"}]->(b) quiere decir que b es President de a, y {type: "Employer"} que b es el empleador de a. En los vínculos familiares la dirección no es confiable: tratalos como no dirigidos. Para buscar caminos usá patrones no dirigidos, como -[:RELATED_TO*1..3]-, siempre con un tope de largo.

CRM:
- (:Contact {fullName, phone, birthday})-[:WORKS_AT]->(:CUIT). (:Contact)-[:IS]->(:CUIT) es el CUIT de la propia persona.
- (:Action {date, description, doneBy})-[:ABOUT]->(:CUIT). (:Action)-[:WITH]->(:Contact). (:Action)-[:DONE_BY]->(:Responsible {name}).
- (:Task {description, dueDate, status, assignee})-[:ABOUT]->(:CUIT). (:Task)-[:ASSIGNED_TO]->(:Responsible).
- (:WebResearch {summary, requestedAt})-[:ABOUT]->(:CUIT) — investigaciones web anteriores.

Las fechas guardadas como texto dd/mm/aaaa no se comparan bien como texto: convertilas antes de comparar. Poné LIMIT en las consultas que puedan devolver muchas filas, salvo que el usuario pida el listado completo.`
