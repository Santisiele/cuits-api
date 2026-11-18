import { describe, it, expect, beforeEach } from "vitest"
import { ChatToolbox } from "@application/ChatToolbox"
import { QUERY_TIMEOUT_MS, ROWS_STORED } from "@domain/aiChat"
import { FakeGraphReader } from "./aiChatFakes"

describe("ChatToolbox", () => {
  let graph: FakeGraphReader
  let toolbox: ChatToolbox
  let ids: number

  beforeEach(() => {
    graph = new FakeGraphReader()
    ids = 0
    toolbox = new ChatToolbox(graph, [], () => `r${++ids}`)
  })

  it("runs a read query with its params, the row cap and the timeout", async () => {
    const outcome = await toolbox.execute("run_query", { cypher: "MATCH (c:CUIT {id: $id}) RETURN c.id", params: { id: "1" } })
    expect(outcome.isError).toBe(false)
    expect(JSON.parse(outcome.content)).toMatchObject({ resultId: "r1", columns: ["cuit", "nombre"], rowCount: 1 })
    expect(graph.calls).toEqual([
      { cypher: "MATCH (c:CUIT {id: $id}) RETURN c.id", params: { id: "1" }, maxRows: ROWS_STORED, timeoutMs: QUERY_TIMEOUT_MS },
    ])
  })

  it("refuses writes without touching the database", async () => {
    const outcome = await toolbox.execute("run_query", { cypher: "MATCH (c) DETACH DELETE c" })
    expect(outcome).toEqual({ content: "Only read queries are allowed (found DETACH)", isError: true })
    expect(graph.calls).toHaveLength(0)
  })

  it("hides secrets in what the database returns", async () => {
    graph.result = {
      columns: ["n", "hash"],
      rows: [[{ _labels: ["User"], username: "x" }, "h"], [{ _labels: ["CUIT"], id: "1", passwordHash: "p" }, "h"]],
      truncated: false,
    }
    const outcome = await toolbox.execute("run_query", { cypher: "MATCH (n) RETURN n, n.x AS hash" })
    expect(JSON.parse(outcome.content)).toMatchObject({ columns: ["n"], rows: [[null], [{ _labels: ["CUIT"], id: "1" }]] })
  })

  it("hands query errors back to Claude instead of failing", async () => {
    graph.failure = new Error("Invalid input 'RETRUN'")
    expect(await toolbox.execute("run_query", { cypher: "MATCH (c) RETRUN c" })).toEqual({
      content: "The query failed: Invalid input 'RETRUN'",
      isError: true,
    })
  })

  it("shows a result as a table once, keeping the latest title", async () => {
    await toolbox.execute("run_query", { cypher: "MATCH (c) RETURN c" })
    expect((await toolbox.execute("show_table", { resultId: "r1", title: "Empresas" })).isError).toBe(false)
    await toolbox.execute("show_table", { resultId: "r1", title: "  " })
    expect(toolbox.tables()).toEqual([
      { resultId: "r1", title: "Listado", columns: ["cuit", "nombre"], rows: [["30712345678", "ACME SA"]], truncated: false },
    ])
    expect(await toolbox.execute("show_table", { resultId: "nope", title: "x" })).toEqual({
      content: "There is no result nope",
      isError: true,
    })
  })

  it("pages through results and earlier tables of the chat", async () => {
    const earlier = { resultId: "old", title: "Viejo", columns: ["n"], rows: Array.from({ length: 250 }, (_, i) => [i]), truncated: false }
    toolbox = new ChatToolbox(graph, [earlier])
    const page = JSON.parse((await toolbox.execute("get_table", { resultId: "old", offset: 200 })).content)
    expect(page.rows).toHaveLength(50)
    expect(page.rows[0]).toEqual([200])
    expect(toolbox.tables()).toEqual([])
  })

  it("rejects unknown tools", async () => {
    expect(await toolbox.execute("drop_everything", {})).toEqual({ content: "Unknown tool drop_everything", isError: true })
  })
})
