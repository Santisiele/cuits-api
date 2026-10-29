import { describe, it, expect, beforeEach, vi } from "vitest"
import { NosisPendingMailService, NosisPendingService } from "@application/NosisPendingService"
import { hourInBuenosAires, isPendingMailDue, pendingMailBody, pendingMailSubject, type NosisRunEvent } from "@domain/nosisPending"
import type { IEnricher } from "@ports/interfaces"
import { InMemoryCrmRepository } from "./crmFakes"

const FIRST = "30712345678"
const SECOND = "30798765432"
const THIRD = "20301234567"

describe("when the pending mail goes out", () => {
  it("reads the hour in Buenos Aires", () => {
    expect(hourInBuenosAires(new Date("2026-10-29T06:00:00.000Z"))).toBe(3)
    expect(hourInBuenosAires(new Date("2026-10-29T02:00:00.000Z"))).toBe(23)
  })

  it("waits for 03:00 in Buenos Aires", () => {
    expect(isPendingMailDue(new Date("2026-10-29T05:59:00.000Z"), null, 4)).toBe(false)
    expect(isPendingMailDue(new Date("2026-10-29T06:00:00.000Z"), null, 4)).toBe(true)
  })

  it("goes once a day, and later that day if the API was down at 03:00", () => {
    expect(isPendingMailDue(new Date("2026-10-29T18:00:00.000Z"), "2026-10-29", 4)).toBe(false)
    expect(isPendingMailDue(new Date("2026-10-29T18:00:00.000Z"), "2026-10-28", 4)).toBe(true)
  })

  it("stays quiet with nothing pending", () => {
    expect(isPendingMailDue(new Date("2026-10-29T06:00:00.000Z"), null, 0)).toBe(false)
  })
})

describe("the pending mail", () => {
  const items = [
    { taxId: FIRST, businessName: "ACME SA", sources: ["CRM Excel"], addedBy: "flavia", addedAt: "2026-10-29T02:00:00.000Z" },
    { taxId: SECOND, businessName: "", sources: [], addedBy: null, addedAt: null },
  ]

  it("counts in the subject", () => {
    expect(pendingMailSubject(1)).toBe("1 CUIT pendiente de Nosis")
    expect(pendingMailSubject(2)).toBe("2 CUITs pendientes de Nosis")
  })

  it("lists each CUIT with who added it and when, in Buenos Aires days, and the command", () => {
    const body = pendingMailBody(items)
    expect(body).toContain(`- ${FIRST} ACME SA — lo agregó flavia el 28/10/2026`)
    expect(body).toContain(`- ${SECOND} (sin nombre) — lo agregó alguien el fecha desconocida`)
    expect(body).toContain("pnpm crm:nosis [cantidad]")
    expect(body).toContain("pnpm crm:nosis --dry-run")
  })
})

describe("NosisPendingMailService", () => {
  let repository: InMemoryCrmRepository
  const sendText = vi.fn()
  const report = vi.fn()

  beforeEach(() => {
    repository = new InMemoryCrmRepository()
    repository.seedCuit(FIRST, { nosisPending: true })
    sendText.mockReset().mockResolvedValue(undefined)
    report.mockReset()
  })

  it("sends once and remembers the day", async () => {
    const service = new NosisPendingMailService(repository, { sendText })
    const at = new Date("2026-10-29T06:30:00.000Z")
    expect(await service.runIfDue(report, at)).toBe(true)
    expect(await service.runIfDue(report, at)).toBe(false)
    expect(sendText).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledWith({ subject: "1 CUIT pendiente de Nosis", body: expect.stringContaining(FIRST) })
    expect(repository.mailDay).toBe("2026-10-29")
    expect(report).toHaveBeenCalledWith({ kind: "sent", count: 1, day: "2026-10-29" })
  })

  it("does not remember the day when the mail fails, so it tries again", async () => {
    sendText.mockRejectedValue(new Error("Resend answered 500"))
    const service = new NosisPendingMailService(repository, { sendText })
    expect(await service.runIfDue(report, new Date("2026-10-29T06:30:00.000Z"))).toBe(false)
    expect(repository.mailDay).toBeNull()
    expect(report).toHaveBeenCalledWith({ kind: "failed", message: "Resend answered 500" })
  })

  it("checks on start and then on a timer", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-29T05:00:00.000Z"))
    const service = new NosisPendingMailService(repository, { sendText })
    const stop = service.start(report, 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(sendText).not.toHaveBeenCalled()
    vi.setSystemTime(new Date("2026-10-29T06:00:00.000Z"))
    await vi.advanceTimersByTimeAsync(1000)
    expect(sendText).toHaveBeenCalledTimes(1)
    stop()
    vi.useRealTimers()
  })
})

describe("NosisPendingService.run", () => {
  let repository: InMemoryCrmRepository
  let events: NosisRunEvent[]
  const graph = { upsertEnrichmentNode: vi.fn(), mergeRelationship: vi.fn() }
  const wait = vi.fn()

  function enricher(overrides: Partial<IEnricher> = {}): IEnricher {
    return {
      resolveDocument: vi.fn(async (document: string) => ({ taxId: document, businessName: "DESDE NOSIS" })),
      fetchRelationshipGraph: vi.fn(async (taxId: string) => ({
        nodes: [
          { taxId, businessName: "DESDE NOSIS" },
          { taxId: "20111111112", businessName: "PEREZ JUAN" },
        ],
        relationships: [{ fromTaxId: taxId, toTaxId: "20111111112", relationshipType: "1" }],
      })),
      ...overrides,
    }
  }

  beforeEach(() => {
    repository = new InMemoryCrmRepository()
    repository.seedCuit(FIRST, { nosisPending: true, businessName: "" })
    repository.seedCuit(SECOND, { nosisPending: true })
    repository.seedCuit(THIRD, { nosisPending: true })
    events = []
    graph.upsertEnrichmentNode.mockReset()
    graph.mergeRelationship.mockReset()
    wait.mockReset().mockResolvedValue(undefined)
  })

  async function run(source: IEnricher) {
    const service = new NosisPendingService(repository, () => new Date("2026-10-29T15:00:00.000Z"))
    return service.run(source, graph, await service.list(), { wait, report: (event) => events.push(event) })
  }

  it("writes the tree, takes the CUIT off the queue and waits between searches only", async () => {
    expect(await run(enricher())).toEqual({ searched: 3, notFound: 0, failed: 0 })
    expect(graph.upsertEnrichmentNode).toHaveBeenCalledTimes(3)
    expect(graph.upsertEnrichmentNode).toHaveBeenCalledWith("20111111112", "PEREZ JUAN")
    expect(graph.mergeRelationship).toHaveBeenCalledTimes(3)
    expect(repository.cuits.get(FIRST)).toMatchObject({ nosisPending: false, businessName: "DESDE NOSIS" })
    expect(repository.cuits.get(SECOND)?.businessName).toBe("ACME SA")
    expect(repository.searchedAt.get(FIRST)).toBe("2026-10-29T15:00:00.000Z")
    expect(wait).toHaveBeenCalledTimes(2)
    expect(events[0]).toMatchObject({ kind: "searched", position: 1, total: 3, related: 1, relationships: 1 })
  })

  it("leaves a CUIT Nosis does not find in the queue", async () => {
    const tally = await run(enricher({ resolveDocument: vi.fn(async () => null) }))
    expect(tally).toEqual({ searched: 0, notFound: 3, failed: 0 })
    expect(repository.cuits.get(FIRST)?.nosisPending).toBe(true)
    expect(events.every((event) => event.kind === "not_found")).toBe(true)
  })

  it("stops after three failures in a row", async () => {
    repository.seedCuit("20999999999", { nosisPending: true })
    const tally = await run(enricher({ resolveDocument: vi.fn(async () => Promise.reject(new Error("session dead"))) }))
    expect(tally).toEqual({ searched: 0, notFound: 0, failed: 3 })
    expect(events.at(-1)).toEqual({ kind: "aborted", failures: 3 })
    expect(repository.cuits.get("20999999999")?.nosisPending).toBe(true)
  })

  it("resets the failure count after a success", async () => {
    let call = 0
    const flaky = enricher({
      resolveDocument: vi.fn(async (document: string) => {
        call++
        if (call === 2) throw new Error("timeout")
        return { taxId: document, businessName: "X" }
      }),
    })
    expect(await run(flaky)).toEqual({ searched: 2, notFound: 0, failed: 1 })
  })
})
