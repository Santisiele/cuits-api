import neo4j from "neo4j-driver"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import type { IManualRunRepository } from "@ports/interfaces.js"
import type { ManualRun, ManualRunStatus } from "@domain/manualRun.js"

function toRun(properties: Record<string, unknown>): ManualRun {
  const exitCode = properties["exitCode"]
  const status = properties["status"]
  return {
    id: String(properties["id"]),
    script: String(properties["script"]),
    args: Array.isArray(properties["args"]) ? properties["args"].map(String) : [],
    by: typeof properties["by"] === "string" ? properties["by"] : null,
    startedAt: String(properties["startedAt"]),
    finishedAt: typeof properties["finishedAt"] === "string" ? properties["finishedAt"] : null,
    status: status === "ok" || status === "failed" ? status : "running",
    exitCode: neo4j.isInt(exitCode) ? exitCode.toNumber() : typeof exitCode === "number" ? exitCode : null,
  }
}

export class Neo4jManualRunRepository implements IManualRunRepository {
  async start(run: ManualRun): Promise<void> {
    const session = Neo4jDriver.instance.session()
    try {
      await session.run(Queries.START_MANUAL_RUN, { ...run })
    } finally {
      await session.close()
    }
  }

  async finish(id: string, status: ManualRunStatus, exitCode: number, finishedAt: string): Promise<void> {
    const session = Neo4jDriver.instance.session()
    try {
      await session.run(Queries.FINISH_MANUAL_RUN, { id, status, exitCode: neo4j.int(exitCode), finishedAt })
    } finally {
      await session.close()
    }
  }

  async list(): Promise<ManualRun[]> {
    const session = Neo4jDriver.instance.session()
    try {
      const result = await session.run(Queries.LIST_MANUAL_RUNS)
      return result.records.map((record) => toRun((record.get("run") as { properties: Record<string, unknown> }).properties))
    } finally {
      await session.close()
    }
  }
}
