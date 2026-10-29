import type { IEnricher, IGraphRepository, INosisPendingRepository, ITextMailer } from "@ports/interfaces.js"
import { todayInBuenosAires } from "@domain/crm.js"
import {
  MAX_CONSECUTIVE_FAILURES,
  isPendingMailDue,
  pendingMailBody,
  pendingMailSubject,
  type NosisPendingItem,
  type NosisRunEvent,
  type NosisRunTally,
} from "@domain/nosisPending.js"

export const PENDING_MAIL_CHECK_MS = 15 * 60 * 1000

export type PendingMailEvent =
  | { kind: "sent"; count: number; day: string }
  | { kind: "failed"; message: string }

export interface NosisRunHooks {
  wait(): Promise<void>
  report(event: NosisRunEvent): void
}

type GraphWriter = Pick<IGraphRepository, "upsertEnrichmentNode" | "mergeRelationship">

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class NosisPendingService {
  constructor(
    private readonly repository: INosisPendingRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  list(): Promise<NosisPendingItem[]> {
    return this.repository.listNosisPending()
  }

  async run(enricher: IEnricher, graph: GraphWriter, items: NosisPendingItem[], hooks: NosisRunHooks): Promise<NosisRunTally> {
    const tally: NosisRunTally = { searched: 0, notFound: 0, failed: 0 }
    let consecutiveFailures = 0

    for (const [index, item] of items.entries()) {
      const position = index + 1
      const total = items.length
      try {
        const identity = await enricher.resolveDocument(item.taxId)
        if (!identity) {
          tally.notFound++
          consecutiveFailures = 0
          hooks.report({ kind: "not_found", position, total, item })
        } else {
          const tree = await enricher.fetchRelationshipGraph(identity.taxId, identity.businessName)
          let related = 0
          for (const node of tree.nodes) {
            if (node.taxId === item.taxId) continue
            await graph.upsertEnrichmentNode(node.taxId, node.businessName)
            related++
          }
          for (const relationship of tree.relationships) await graph.mergeRelationship(relationship)
          await this.repository.markNosisSearched(item.taxId, identity.businessName, this.now().toISOString())
          tally.searched++
          consecutiveFailures = 0
          hooks.report({ kind: "searched", position, total, item, related, relationships: tree.relationships.length })
        }
      } catch (error) {
        tally.failed++
        consecutiveFailures++
        hooks.report({ kind: "failed", position, total, item, message: messageOf(error) })
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          hooks.report({ kind: "aborted", failures: consecutiveFailures })
          return tally
        }
      }
      if (position < total) await hooks.wait()
    }
    return tally
  }
}

export class NosisPendingMailService {
  constructor(
    private readonly repository: INosisPendingRepository,
    private readonly mailer: ITextMailer
  ) {}

  async runIfDue(report: (event: PendingMailEvent) => void, now: Date = new Date()): Promise<boolean> {
    try {
      const [items, lastSentDay] = await Promise.all([this.repository.listNosisPending(), this.repository.lastPendingMailDay()])
      if (!isPendingMailDue(now, lastSentDay, items.length)) return false
      const day = todayInBuenosAires(now)
      await this.mailer.sendText({ subject: pendingMailSubject(items.length), body: pendingMailBody(items) })
      await this.repository.recordPendingMail(day, now.toISOString())
      report({ kind: "sent", count: items.length, day })
      return true
    } catch (error) {
      report({ kind: "failed", message: messageOf(error) })
      return false
    }
  }

  start(report: (event: PendingMailEvent) => void, checkMs: number = PENDING_MAIL_CHECK_MS): () => void {
    void this.runIfDue(report)
    const timer = setInterval(() => void this.runIfDue(report), checkMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
