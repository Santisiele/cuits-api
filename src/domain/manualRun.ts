import type { ActivityEntry } from "@domain/activityLog.js"

export type ManualRunStatus = "running" | "ok" | "failed"

export interface ManualRun {
  id: string
  script: string
  args: string[]
  by: string | null
  startedAt: string
  finishedAt: string | null
  status: ManualRunStatus
  exitCode: number | null
}

export function manualRunBy(args: readonly string[]): string | null {
  const index = args.indexOf("--by")
  const value = index >= 0 ? args[index + 1] : undefined
  return value && !value.startsWith("--") ? value : null
}

export function manualRunStatus(exitCode: number | null): ManualRunStatus {
  return exitCode === 0 ? "ok" : "failed"
}

export function manualRunEntry(run: ManualRun): ActivityEntry {
  return {
    time: run.startedAt,
    level: run.status === "failed" ? "error" : "info",
    event: "manual_run",
    username: run.by,
    details: { script: run.script, args: run.args, status: run.status, finishedAt: run.finishedAt, exitCode: run.exitCode, manual: true },
  }
}
