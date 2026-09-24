import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  BackupService,
  BACKUP_INTERVAL_MS,
  BACKUP_CHECK_MS,
  backupFileName,
  isDue,
  type BackupEvent,
} from "@application/BackupService"
import type { GraphBackup } from "@domain/backup"

const NOW = new Date("2026-09-24T18:00:00.000Z")

const BACKUP: GraphBackup = {
  exportedAt: NOW.toISOString(),
  nodes: [
    { key: "n1", labels: ["CUIT"], properties: { id: "30500904557" } },
    { key: "n2", labels: ["Source"], properties: { name: "Bolsa" } },
  ],
  relationships: [{ from: "n1", to: "n2", type: "HAS_SOURCE", properties: {} }],
}

function makeRepo() {
  return {
    exportGraph: vi.fn(async (exportedAt: string): Promise<GraphBackup> => ({ ...BACKUP, exportedAt })),
    lastBackupAt: vi.fn(async (): Promise<string | null> => null),
    recordBackup: vi.fn(async (_at: string): Promise<void> => undefined),
    countAllNodes: vi.fn(async () => 0),
    restoreNodeBatch: vi.fn(async () => 0),
    restoreRelationshipBatch: vi.fn(async () => 0),
    clearBackupKeys: vi.fn(async () => 0),
  }
}

interface SentMail {
  subject: string
  body: string
  filename: string
  content: Buffer
}

function makeMailer() {
  return { send: vi.fn(async (_message: SentMail): Promise<void> => undefined) }
}

function firstMail(mailer: ReturnType<typeof makeMailer>): SentMail {
  const call = mailer.send.mock.calls[0]
  if (!call) throw new Error("no mail was sent")
  return call[0]
}

function makeHooks() {
  const events: BackupEvent[] = []
  return { events, hooks: { report: (event: BackupEvent) => events.push(event) } }
}

describe("backupFileName", () => {
  it("names the file after the day it was taken", () => {
    expect(backupFileName("2026-09-24T18:00:00.000Z")).toBe("cuits-backup-2026-09-24.gz.aes")
  })
})

describe("isDue", () => {
  it("is due when there has never been a backup", () => {
    expect(isDue(null, NOW, BACKUP_INTERVAL_MS)).toBe(true)
  })

  it("is not due the day after one ran", () => {
    expect(isDue("2026-09-23T18:00:00.000Z", NOW, BACKUP_INTERVAL_MS)).toBe(false)
  })

  it("is due once the week is up", () => {
    expect(isDue("2026-09-17T18:00:00.000Z", NOW, BACKUP_INTERVAL_MS)).toBe(true)
  })

  it("is due when the stored date is unreadable", () => {
    expect(isDue("cualquier cosa", NOW, BACKUP_INTERVAL_MS)).toBe(true)
  })
})

describe("BackupService", () => {
  let repo: ReturnType<typeof makeRepo>
  let mailer: ReturnType<typeof makeMailer>
  let pack: ReturnType<typeof vi.fn>
  let service: BackupService

  beforeEach(() => {
    repo = makeRepo()
    mailer = makeMailer()
    pack = vi.fn((json: string) => Buffer.from(`cifrado:${json.length}`))
    service = new BackupService(repo, mailer, pack as unknown as (json: string) => Buffer)
  })

  describe("a run", () => {
    it("exports the whole graph", async () => {
      await service.run(makeHooks().hooks, NOW)
      expect(repo.exportGraph).toHaveBeenCalledWith(NOW.toISOString())
    })

    it("encrypts before sending, never mailing the plain export", async () => {
      await service.run(makeHooks().hooks, NOW)
      const sent = firstMail(mailer)
      expect(pack).toHaveBeenCalledTimes(1)
      expect(sent.content.toString()).toMatch(/^cifrado:/)
    })

    it("attaches the file named after the day", async () => {
      await service.run(makeHooks().hooks, NOW)
      const sent = firstMail(mailer)
      expect(sent.filename).toBe("cuits-backup-2026-09-24.gz.aes")
    })

    it("says in the mail how much it saved", async () => {
      await service.run(makeHooks().hooks, NOW)
      const sent = firstMail(mailer)
      expect(sent.body).toContain("2 nodes and 1 relationships")
    })

    it("writes down when it ran, so the next one waits a week", async () => {
      await service.run(makeHooks().hooks, NOW)
      expect(repo.recordBackup).toHaveBeenCalledWith(NOW.toISOString())
    })

    it("reports what it sent", async () => {
      const { hooks, events } = makeHooks()
      await service.run(hooks, NOW)
      expect(events[0]).toMatchObject({ kind: "sent", filename: "cuits-backup-2026-09-24.gz.aes" })
    })
  })

  describe("when something goes wrong", () => {
    it("does not mark the backup as done if the mail failed", async () => {
      mailer.send.mockRejectedValue(new Error("Resend answered 401"))
      await service.run(makeHooks().hooks, NOW)
      expect(repo.recordBackup).not.toHaveBeenCalled()
    })

    it("reports the reason instead of throwing", async () => {
      mailer.send.mockRejectedValue(new Error("Resend answered 401"))
      const { hooks, events } = makeHooks()
      await expect(service.run(hooks, NOW)).resolves.toBe(false)
      expect(events[0]).toMatchObject({ kind: "failed", message: "Resend answered 401" })
    })

    it("sends nothing when the export itself fails", async () => {
      repo.exportGraph.mockRejectedValue(new Error("Aura down"))
      await service.run(makeHooks().hooks, NOW)
      expect(mailer.send).not.toHaveBeenCalled()
    })
  })

  describe("only when due", () => {
    it("runs when there has never been a backup", async () => {
      await service.runIfDue(makeHooks().hooks, NOW)
      expect(mailer.send).toHaveBeenCalledTimes(1)
    })

    it("does not send another one the day after", async () => {
      repo.lastBackupAt.mockResolvedValue("2026-09-23T18:00:00.000Z")
      await service.runIfDue(makeHooks().hooks, NOW)
      expect(mailer.send).not.toHaveBeenCalled()
    })

    it("says it is waiting rather than staying silent", async () => {
      repo.lastBackupAt.mockResolvedValue("2026-09-23T18:00:00.000Z")
      const { hooks, events } = makeHooks()
      await service.runIfDue(hooks, NOW)
      expect(events[0]).toEqual({ kind: "waiting", lastRunAt: "2026-09-23T18:00:00.000Z" })
    })

    it("sends again once the week is up", async () => {
      repo.lastBackupAt.mockResolvedValue("2026-09-17T18:00:00.000Z")
      await service.runIfDue(makeHooks().hooks, NOW)
      expect(mailer.send).toHaveBeenCalledTimes(1)
    })

    it("does not resend on every restart, which is why the date lives in the graph", async () => {
      repo.lastBackupAt.mockResolvedValue("2026-09-22T18:00:00.000Z")
      await service.runIfDue(makeHooks().hooks, NOW)
      await service.runIfDue(makeHooks().hooks, NOW)
      expect(mailer.send).not.toHaveBeenCalled()
    })
  })

  describe("on a schedule", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("checks as soon as it starts", async () => {
      service.start(makeHooks().hooks)
      await vi.advanceTimersByTimeAsync(0)
      expect(repo.lastBackupAt).toHaveBeenCalledTimes(1)
    })

    it("keeps checking through the week without sending twice", async () => {
      repo.lastBackupAt.mockResolvedValue("2026-09-24T18:00:00.000Z")
      service.start(makeHooks().hooks)
      await vi.advanceTimersByTimeAsync(BACKUP_CHECK_MS * 4)
      expect(mailer.send).not.toHaveBeenCalled()
      expect(repo.lastBackupAt.mock.calls.length).toBeGreaterThan(1)
    })

    it("stops when told to", async () => {
      const stop = service.start(makeHooks().hooks)
      await vi.advanceTimersByTimeAsync(0)
      stop()
      await vi.advanceTimersByTimeAsync(BACKUP_CHECK_MS * 5)
      expect(repo.lastBackupAt).toHaveBeenCalledTimes(1)
    })

    it("checks more often than it backs up, so a restart cannot skip a week", () => {
      expect(BACKUP_CHECK_MS).toBeLessThan(BACKUP_INTERVAL_MS)
    })
  })
})
