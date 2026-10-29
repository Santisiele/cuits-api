import { describe, it, expect, vi, beforeEach } from "vitest"
import { ManualRunService } from "@application/ManualRunService"
import { ActivityLogService } from "@application/ActivityLogService"
import { parseActivityFilters } from "@domain/activityLog"
import { manualRunBy, manualRunEntry, type ManualRun, type ManualRunStatus } from "@domain/manualRun"
import type { IManualRunRepository } from "@ports/interfaces"

const START = new Date("2026-10-29T15:00:00.000Z")
const END = new Date("2026-10-29T15:05:00.000Z")

class FakeRuns implements IManualRunRepository {
  runs: ManualRun[] = []
  failing = false
  async start(run: ManualRun): Promise<void> {
    if (this.failing) throw new Error("database down")
    this.runs.push({ ...run })
  }
  async finish(id: string, status: ManualRunStatus, exitCode: number, finishedAt: string): Promise<void> {
    Object.assign(this.runs.find((run) => run.id === id)!, { status, exitCode, finishedAt })
  }
  async list(): Promise<ManualRun[]> {
    return this.runs
  }
}

let runs: FakeRuns
let clock: Date[]
const warn = vi.fn()

function service(exitCode: number) {
  const runScript = vi.fn(async () => exitCode)
  return { runScript, service: new ManualRunService(runs, runScript, warn, () => clock.shift()!, () => "r1") }
}

beforeEach(() => {
  runs = new FakeRuns()
  clock = [START, END]
  warn.mockReset()
})

describe("ManualRunService", () => {
  it("records that a script was run by hand, with its arguments, who and how it ended", async () => {
    const { runScript, service: manual } = service(0)
    expect(await manual.run("crm:import", "src/scripts/crmImport.ts", ["Listas.xlsx", "--by", "sol", "--apply"])).toBe(0)
    expect(runScript).toHaveBeenCalledWith("src/scripts/crmImport.ts", ["Listas.xlsx", "--by", "sol", "--apply"])
    expect(runs.runs).toEqual([
      {
        id: "r1",
        script: "crm:import",
        args: ["Listas.xlsx", "--by", "sol", "--apply"],
        by: "sol",
        startedAt: START.toISOString(),
        finishedAt: END.toISOString(),
        status: "ok",
        exitCode: 0,
      },
    ])
  })

  it("records a failure with its exit code", async () => {
    const { service: manual } = service(2)
    expect(await manual.run("load:bolsa", "src/scripts/loadFromBolsa.ts", [])).toBe(2)
    expect(runs.runs[0]).toMatchObject({ status: "failed", exitCode: 2, by: null })
  })

  it("still runs the script when the run cannot be recorded", async () => {
    runs.failing = true
    const { runScript, service: manual } = service(0)
    expect(await manual.run("load:bolsa", "src/scripts/loadFromBolsa.ts", [])).toBe(0)
    expect(runScript).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("database down"))
  })
})

describe("manual runs in the activity log", () => {
  const run: ManualRun = {
    id: "r1",
    script: "load:bolsa",
    args: ["bolsa.xlsx"],
    by: null,
    startedAt: "2026-10-29T13:30:00.000Z",
    finishedAt: "2026-10-29T13:31:00.000Z",
    status: "ok",
    exitCode: 0,
  }

  it("reads who ran it only from --by", () => {
    expect(manualRunBy(["x", "--by", "luchi"])).toBe("luchi")
    expect(manualRunBy(["x", "--by", "--apply"])).toBeNull()
    expect(manualRunBy([])).toBeNull()
  })

  it("marks each run as done by hand and fails it loudly", () => {
    expect(manualRunEntry(run)).toMatchObject({ event: "manual_run", level: "info", details: { script: "load:bolsa", manual: true } })
    expect(manualRunEntry({ ...run, status: "failed" }).level).toBe("error")
  })

  it("slots the runs between the log lines by time", async () => {
    async function* lines(): AsyncIterable<string> {
      yield JSON.stringify({ level: 30, time: Date.UTC(2026, 9, 29, 13), event: "login", username: "sol" })
      yield JSON.stringify({ level: 30, time: Date.UTC(2026, 9, 29, 14), event: "logout", username: "sol" })
    }
    const page = await new ActivityLogService(lines, async () => [manualRunEntry(run)]).read(parseActivityFilters({}))
    expect(page.entries.map((entry) => entry.event)).toEqual(["logout", "manual_run", "login"])
    const onlyManual = await new ActivityLogService(lines, async () => [manualRunEntry(run)]).read(parseActivityFilters({ event: "manual_run" }))
    expect(onlyManual.entries).toHaveLength(1)
  })
})
