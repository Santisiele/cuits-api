import { randomUUID } from "crypto"
import type { IGraphReader } from "@ports/interfaces.js"
import {
  QUERY_TIMEOUT_MS,
  ROWS_STORED,
  cypherRejection,
  describeResult,
  hideResult,
  rowsForStorage,
  type ChatTable,
  type QueryResult,
  type ToolOutcome,
} from "@domain/aiChat.js"

function failure(message: string): ToolOutcome {
  return { content: message, isError: true }
}

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

export class ChatToolbox {
  private readonly results = new Map<string, QueryResult>()
  private readonly shown: ChatTable[] = []

  constructor(
    private readonly graph: IGraphReader,
    earlierTables: readonly ChatTable[] = [],
    private readonly newId: () => string = () => randomUUID().slice(0, 8)
  ) {
    for (const table of earlierTables) {
      this.results.set(table.resultId, { columns: table.columns, rows: table.rows, truncated: table.truncated })
    }
  }

  tables(): ChatTable[] {
    return [...this.shown]
  }

  execute = async (name: string, input: unknown): Promise<ToolOutcome> => {
    const args = asRecord(input)
    if (name === "run_query") return this.runQuery(args)
    if (name === "show_table") return this.showTable(args)
    if (name === "get_table") return this.getTable(args)
    return failure(`Unknown tool ${name}`)
  }

  private async runQuery(args: Record<string, unknown>): Promise<ToolOutcome> {
    const cypher = args["cypher"]
    const rejection = cypherRejection(cypher)
    if (rejection || typeof cypher !== "string") return failure(rejection ?? "The query is empty")
    try {
      const raw = await this.graph.read(cypher, asRecord(args["params"]), ROWS_STORED, QUERY_TIMEOUT_MS)
      const result = hideResult({ ...raw, rows: rowsForStorage(raw.rows) })
      const resultId = this.newId()
      this.results.set(resultId, result)
      return { content: describeResult(resultId, result), isError: false }
    } catch (err) {
      return failure(`The query failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private showTable(args: Record<string, unknown>): ToolOutcome {
    const resultId = String(args["resultId"] ?? "")
    const result = this.results.get(resultId)
    if (!result) return failure(`There is no result ${resultId}`)
    const title = String(args["title"] ?? "").trim() || "Listado"
    const existing = this.shown.findIndex((table) => table.resultId === resultId)
    const table: ChatTable = { resultId, title, ...result }
    if (existing >= 0) this.shown[existing] = table
    else this.shown.push(table)
    return { content: `The table "${title}" with ${result.rows.length} rows is shown to the user.`, isError: false }
  }

  private getTable(args: Record<string, unknown>): ToolOutcome {
    const resultId = String(args["resultId"] ?? "")
    const result = this.results.get(resultId)
    if (!result) return failure(`There is no result ${resultId}`)
    const offset = Number.isInteger(args["offset"]) && Number(args["offset"]) > 0 ? Number(args["offset"]) : 0
    return { content: describeResult(resultId, result, offset), isError: false }
  }
}
