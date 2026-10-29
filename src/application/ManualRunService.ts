import { randomUUID } from "crypto"
import type { IManualRunRepository } from "@ports/interfaces.js"
import { manualRunBy, manualRunStatus, type ManualRun } from "@domain/manualRun.js"

export type RunScript = (script: string, args: readonly string[]) => Promise<number>

export class ManualRunService {
  constructor(
    private readonly repository: IManualRunRepository,
    private readonly runScript: RunScript,
    private readonly warn: (message: string) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID
  ) {}

  async run(name: string, script: string, args: readonly string[]): Promise<number> {
    const run: ManualRun = {
      id: this.newId(),
      script: name,
      args: [...args],
      by: manualRunBy(args),
      startedAt: this.now().toISOString(),
      finishedAt: null,
      status: "running",
      exitCode: null,
    }
    const recorded = await this.attempt(() => this.repository.start(run))
    const exitCode = await this.runScript(script, args)
    if (recorded) {
      await this.attempt(() => this.repository.finish(run.id, manualRunStatus(exitCode), exitCode, this.now().toISOString()))
    }
    return exitCode
  }

  private async attempt(write: () => Promise<void>): Promise<boolean> {
    try {
      await write()
      return true
    } catch (err) {
      this.warn(`Could not record the manual run in the activity log: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
}
