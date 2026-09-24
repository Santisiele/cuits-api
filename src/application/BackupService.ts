import type { IBackupMailer, IBackupRepository } from "@ports/interfaces.js"
import { summarise, type GraphBackup } from "@domain/backup.js"

export const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
export const BACKUP_CHECK_MS = 6 * 60 * 60 * 1000

export type BackupEvent =
  | { kind: "sent"; filename: string; bytes: number; summary: string }
  | { kind: "waiting"; lastRunAt: string }
  | { kind: "failed"; message: string }

export interface BackupHooks {
  report(event: BackupEvent): void
}

export function backupFileName(exportedAt: string): string {
  return `cuits-backup-${exportedAt.slice(0, 10)}.gz.aes`
}

export function isDue(lastRunAt: string | null, now: Date, everyMs: number): boolean {
  if (lastRunAt === null) return true
  const last = Date.parse(lastRunAt)
  if (Number.isNaN(last)) return true
  return now.getTime() - last >= everyMs
}

export class BackupService {
  constructor(
    private readonly repository: IBackupRepository,
    private readonly mailer: IBackupMailer,
    private readonly pack: (json: string) => Buffer
  ) {}

  async run(hooks: BackupHooks, now: Date = new Date()): Promise<boolean> {
    const exportedAt = now.toISOString()
    try {
      const backup: GraphBackup = await this.repository.exportGraph(exportedAt)
      const content = this.pack(JSON.stringify(backup))
      const filename = backupFileName(exportedAt)
      const summary = summarise(backup)

      await this.mailer.send({
        subject: `Backup de la base — ${exportedAt.slice(0, 10)}`,
        body: `Backup del ${exportedAt.slice(0, 10)} con ${summary}. El archivo está cifrado: hace falta la clave para abrirlo.`,
        filename,
        content,
      })
      await this.repository.recordBackup(exportedAt)
      hooks.report({ kind: "sent", filename, bytes: content.length, summary })
      return true
    } catch (error) {
      hooks.report({ kind: "failed", message: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  async runIfDue(hooks: BackupHooks, now: Date = new Date(), everyMs: number = BACKUP_INTERVAL_MS): Promise<boolean> {
    let lastRunAt: string | null
    try {
      lastRunAt = await this.repository.lastBackupAt()
    } catch (error) {
      hooks.report({ kind: "failed", message: error instanceof Error ? error.message : String(error) })
      return false
    }

    if (!isDue(lastRunAt, now, everyMs)) {
      hooks.report({ kind: "waiting", lastRunAt: lastRunAt as string })
      return false
    }
    return this.run(hooks, now)
  }

  start(
    hooks: BackupHooks,
    everyMs: number = BACKUP_INTERVAL_MS,
    checkMs: number = BACKUP_CHECK_MS
  ): () => void {
    void this.runIfDue(hooks, new Date(), everyMs)
    const timer = setInterval(() => void this.runIfDue(hooks, new Date(), everyMs), checkMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
