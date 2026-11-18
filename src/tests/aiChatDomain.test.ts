import { describe, it, expect } from "vitest"
import {
  ROWS_FOR_MODEL,
  chatTitle,
  cypherRejection,
  describeResult,
  hideResult,
  hideSecrets,
  historyFrom,
  normaliseQuestion,
  rowsForStorage,
  type AiChatMessage,
} from "@domain/aiChat"

function message(overrides: Partial<AiChatMessage>): AiChatMessage {
  return {
    id: "m",
    chatId: "c",
    role: "user",
    createdAt: "2026-11-18T12:00:00.000Z",
    text: "",
    sources: [],
    tables: [],
    status: "done",
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    webSearches: 0,
    costUsd: 0,
    ...overrides,
  }
}

describe("cypherRejection", () => {
  it.each([
    "MATCH (c:CUIT {id: $id}) RETURN c.businessName",
    "MATCH (c:CUIT) WHERE c.inMyBase RETURN c.id, c.businessName LIMIT 50",
    "MATCH p = (a:CUIT {id: '20111111112'})-[:RELATED_TO*1..3]-(b:CUIT {isKnown: true}) RETURN p LIMIT 10",
    "MATCH (c:CUIT) WHERE c.businessName CONTAINS 'CREATE SET DELETE' RETURN c",
    'MATCH (c:CUIT) WHERE c.businessName = "MERGE" RETURN c',
    "MATCH (c:CUIT) RETURN c.start, c.set, $use",
    "CALL db.labels()",
    "CALL db.schema.nodeTypeProperties() YIELD nodeLabels RETURN nodeLabels",
    "MATCH (c:CUIT) CALL { WITH c MATCH (c)-[:RELATED_TO]-(r) RETURN count(r) AS n } RETURN c.id, n",
    "MATCH (c:CUIT)-[:RELATED_TO {type: `Check Signer`}]->(x) RETURN x;",
    "// comment with DELETE\nMATCH (c:CUIT) RETURN c",
  ])("accepts a read query: %s", (cypher) => {
    expect(cypherRejection(cypher)).toBeNull()
  })

  it.each([
    ["CREATE (c:CUIT {id: '1'})", "CREATE"],
    ["MATCH (c:CUIT) SET c.levelOfTrust = 1", "SET"],
    ["INSERT (:CUIT {id: '1'})", "INSERT"],
    ["MATCH (c:CUIT) DETACH DELETE c", "DETACH"],
    ["MATCH (c:CUIT) merge (c)-[:X]->(c)", "MERGE"],
    ["MATCH (c:CUIT) REMOVE c.email", "REMOVE"],
    ["LOAD CSV FROM 'http://x' AS row RETURN row", "LOAD"],
    ["MATCH (c) FOREACH (x IN [1] | SET c.a = x)", "FOREACH"],
    ["SHOW USERS", "SHOW"],
    ["DROP INDEX x", "DROP"],
  ])("rejects a write: %s", (cypher, keyword) => {
    expect(cypherRejection(cypher)).toContain(keyword)
  })

  it.each([
    "CALL apoc.periodic.iterate('a', 'b', {})",
    "RETURN apoc.text.join(['a'], ',')",
    "CALL dbms.components()",
    "CALL db.index.fulltext.queryNodes('x', 'y')",
    "CALL gds.graph.list()",
  ])("rejects procedures outside the allowlist: %s", (cypher) => {
    expect(cypherRejection(cypher)).not.toBeNull()
  })

  it.each(["MATCH (u:User) RETURN u", "MATCH (b:`AiBudget`) RETURN b", "MATCH (m:AiChatMessage) RETURN m.text"])(
    "rejects hidden labels: %s",
    (cypher) => {
      expect(cypherRejection(cypher)).toBe("That label is not available")
    }
  )

  it("rejects several statements, empty and non-text queries", () => {
    expect(cypherRejection("MATCH (c) RETURN c; MATCH (d) RETURN d")).toBe("Only one statement per query")
    expect(cypherRejection("   ")).toBe("The query is empty")
    expect(cypherRejection(undefined)).toBe("The query is empty")
    expect(cypherRejection("x".repeat(8001))).toContain("longer")
  })
})

describe("hideSecrets", () => {
  it("drops hidden entities and secret-looking properties at any depth", () => {
    const value = [
      { _labels: ["User"], username: "santi", passwordHash: "x" },
      { _labels: ["CUIT"], id: "1", nested: { apiToken: "t", ok: 1 } },
      { passwordHash: "y", name: "a" },
    ]
    expect(hideSecrets(value)).toEqual([null, { _labels: ["CUIT"], id: "1", nested: { ok: 1 } }, { name: "a" }])
  })

  it("drops whole columns whose name looks secret", () => {
    const result = hideResult({ columns: ["name", "u.passwordHash"], rows: [["a", "hash"]], truncated: false })
    expect(result).toEqual({ columns: ["name"], rows: [["a"]], truncated: false })
  })
})

describe("result shaping", () => {
  it("gives the model the first rows with long texts cut and says how to read the rest", () => {
    const rows = Array.from({ length: ROWS_FOR_MODEL + 5 }, (_, index) => [index, "x".repeat(600)])
    const described = JSON.parse(describeResult("r1", { columns: ["n", "text"], rows, truncated: true }))
    expect(described.rowCount).toBe(ROWS_FOR_MODEL + 5)
    expect(described.rows).toHaveLength(ROWS_FOR_MODEL)
    expect(described.rows[0][1]).toContain("[100 more characters]")
    expect(described.moreRowsInDatabase).toBe(true)
    expect(described.note).toContain("get_table")
    const rest = JSON.parse(describeResult("r1", { columns: ["n", "text"], rows, truncated: false }, ROWS_FOR_MODEL))
    expect(rest.rows).toHaveLength(5)
    expect(rest.note).toBeUndefined()
  })

  it("keeps up to 5000 rows for storage", () => {
    const rows = Array.from({ length: 5003 }, (_, index) => [index])
    expect(rowsForStorage(rows)).toHaveLength(5000)
  })
})

describe("questions and history", () => {
  it("trims questions and rejects empty, long or non-text ones", () => {
    expect(normaliseQuestion("  hola  ")).toBe("hola")
    expect(normaliseQuestion("   ")).toBeNull()
    expect(normaliseQuestion(5)).toBeNull()
    expect(normaliseQuestion("a".repeat(4001))).toBeNull()
  })

  it("titles a chat with its first question, cut to 80 characters", () => {
    expect(chatTitle("¿Quiénes\n operan en bolsa?")).toBe("¿Quiénes operan en bolsa?")
    expect(chatTitle("a".repeat(100))).toHaveLength(80)
  })

  it("replays finished messages, notes their tables and skips running ones", () => {
    const history = historyFrom([
      message({ role: "user", text: "listá" }),
      message({
        role: "assistant",
        text: "Acá está",
        tables: [{ resultId: "r1", title: "Bolsa", columns: ["cuit"], rows: [["1"], ["2"]], truncated: false }],
      }),
      message({ role: "user", text: "otra" }),
      message({ role: "assistant", text: "", status: "failed" }),
      message({ role: "user", text: "y?" }),
      message({ role: "assistant", text: "", status: "running" }),
    ])
    expect(history).toEqual([
      { role: "user", text: "listá" },
      { role: "assistant", text: 'Acá está\n\n[Listado r1: "Bolsa", 2 filas, columnas cuit]' },
      { role: "user", text: "otra" },
      { role: "assistant", text: "(No llegué a completar esta respuesta.)" },
      { role: "user", text: "y?" },
    ])
  })

  it("keeps the last 30 messages and always starts with a question", () => {
    const messages = Array.from({ length: 41 }, (_, index) =>
      message({ role: index % 2 === 0 ? "user" : "assistant", text: String(index) })
    )
    const history = historyFrom(messages)
    expect(history[0]).toEqual({ role: "user", text: "12" })
    expect(history).toHaveLength(29)
  })
})
