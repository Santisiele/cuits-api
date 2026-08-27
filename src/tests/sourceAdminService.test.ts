import { describe, it, expect, vi, beforeEach } from "vitest"
import type { IGraphRepository } from "@ports/interfaces"

/**
 * The activity logger opens a pino file destination at import time. Mocking it
 * keeps the suite off the filesystem and lets the logging contract itself be
 * asserted.
 */
vi.mock("@auth/activityLogger.js", () => ({
  logSourceOperationInitiated: vi.fn(),
  logSourceOperationCompleted: vi.fn(),
  logSourceOperationFailed: vi.fn(),
}))

const { SourceAdminService, SourceAdminError } = await import(
  "@application/SourceAdminService"
)
const {
  logSourceOperationInitiated,
  logSourceOperationCompleted,
  logSourceOperationFailed,
} = await import("@auth/activityLogger.js")

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Repository double covering only the source-admin surface. Defaults describe
 * the happy path — an existing source with no attached nodes — so each test
 * overrides just the calls it cares about.
 */
function makeRepo(overrides: Record<string, unknown> = {}) {
  const repo = {
    countCuitsForSource: vi.fn(async () => 0),
    checkSourceExists: vi.fn(async () => true),
    findCuitIdsForSource: vi.fn(async () => [] as string[]),
    checkRenameEligibility: vi.fn(async () => ({ sourceExists: true, newNameExists: false })),
    renameSourceNode: vi.fn(async () => "known"),
    updateSourcesArrayForRenameBatch: vi.fn(async (_o: string, _n: string, _b: number) => 0),
    checkMergeEligibility: vi.fn(async () => ({
      keepExists: true,
      dropExists: true,
      keepCategory: "known",
      dropCategory: "known",
    })),
    mergeSourceRelationshipsBatch: vi.fn(async (_k: string, _d: string, _b: number) => 0),
    finalizeSourceMerge: vi.fn(async () => undefined),
    deleteSourceRelationshipsBatch: vi.fn(async (_s: string, _b: number) => 0),
    deleteSourceNode: vi.fn(async () => undefined),
    countOrphansForSource: vi.fn(async () => 0),
    deleteOrphanedNodesBatch: vi.fn(async (_taxIds: string[]) => 0),
    checkAddEligibility: vi.fn(async () => ({ nodeExists: true, sourceExists: true })),
    addSourceToNode: vi.fn(async () => undefined),
    checkMoveEligibility: vi.fn(async () => ({
      nodeExists: true,
      fromExists: true,
      toExists: true,
    })),
    moveSourceOnNode: vi.fn(async () => undefined),
    ...overrides,
  }
  const service = new SourceAdminService(repo as unknown as IGraphRepository)
  return { repo, service }
}

/**
 * Returns a mock that yields each count in turn, then 0 forever.
 * Declared variadic so callers can still inspect the arguments it received.
 */
function batches(...counts: number[]) {
  const queue = [...counts]
  return vi.fn(async (..._args: never[]) => queue.shift() ?? 0)
}

/** Asserts the promise rejects with a SourceAdminError carrying `reason`. */
async function expectRejection(promise: Promise<unknown>, reason: string) {
  await expect(promise).rejects.toBeInstanceOf(SourceAdminError)
  await promise.catch((err: unknown) => {
    expect((err as InstanceType<typeof SourceAdminError>).reason).toBe(reason)
  })
}

beforeEach(() => {
  vi.mocked(logSourceOperationInitiated).mockClear()
  vi.mocked(logSourceOperationCompleted).mockClear()
  vi.mocked(logSourceOperationFailed).mockClear()
})

// ─── renameSource ─────────────────────────────────────────────────────────────

describe("SourceAdminService.renameSource", () => {
  it("rejects an empty new name", async () => {
    const { service } = makeRepo()
    await expectRejection(service.renameSource("A", "   ", "u", false), "name_conflict")
  })

  it("rejects when the source does not exist", async () => {
    const { service } = makeRepo({
      checkRenameEligibility: vi.fn(async () => ({ sourceExists: false, newNameExists: false })),
    })
    await expectRejection(service.renameSource("A", "B", "u", false), "source_not_found")
  })

  it("rejects when the new name is already taken", async () => {
    const { service } = makeRepo({
      checkRenameEligibility: vi.fn(async () => ({ sourceExists: true, newNameExists: true })),
    })
    await expectRejection(service.renameSource("A", "B", "u", false), "name_conflict")
  })

  it("dry run reports the count without writing", async () => {
    const { repo, service } = makeRepo({ countCuitsForSource: vi.fn(async () => 42) })
    const summary = await service.renameSource("A", "B", "u", true)

    expect(summary).toMatchObject({
      operation: "rename",
      affectedNodeCount: 42,
      updatedNodeCount: 42,
      removedNodeCount: 0,
      createdSourceName: "B",
      removedSourceName: "A",
      dryRun: true,
    })
    expect(repo.renameSourceNode).not.toHaveBeenCalled()
    expect(repo.updateSourcesArrayForRenameBatch).not.toHaveBeenCalled()
    expect(logSourceOperationInitiated).not.toHaveBeenCalled()
  })

  it("renames and loops the array update until a batch comes back empty", async () => {
    const { repo, service } = makeRepo({
      countCuitsForSource: vi.fn(async () => 2500),
      updateSourcesArrayForRenameBatch: batches(1000, 1000, 500),
    })
    const summary = await service.renameSource("A", "B", "u", false)

    expect(repo.renameSourceNode).toHaveBeenCalledWith("A", "B")
    expect(repo.updateSourcesArrayForRenameBatch).toHaveBeenCalledTimes(4)
    expect(repo.updateSourcesArrayForRenameBatch).toHaveBeenCalledWith("A", "B", 1000)
    expect(summary.updatedNodeCount).toBe(2500)
    expect(summary.dryRun).toBe(false)
  })

  it("trims the new name before using it", async () => {
    const { repo, service } = makeRepo()
    await service.renameSource("A", "  B  ", "u", false)
    expect(repo.renameSourceNode).toHaveBeenCalledWith("A", "B")
  })

  it("logs start and completion", async () => {
    const { service } = makeRepo()
    await service.renameSource("A", "B", "sofia", false)

    expect(logSourceOperationInitiated).toHaveBeenCalledWith(
      expect.objectContaining({ event: "source_rename_initiated", username: "sofia" })
    )
    expect(logSourceOperationCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ event: "source_rename_completed" })
    )
  })

  it("logs the failure and rethrows when a batch blows up", async () => {
    const { service } = makeRepo({
      updateSourcesArrayForRenameBatch: vi.fn(async () => {
        throw new Error("boom")
      }),
    })
    await expect(service.renameSource("A", "B", "u", false)).rejects.toThrow("boom")
    expect(logSourceOperationFailed).toHaveBeenCalledWith(
      expect.objectContaining({ event: "source_rename_failed", error: "boom" })
    )
    expect(logSourceOperationCompleted).not.toHaveBeenCalled()
  })
})

// ─── mergeSources ─────────────────────────────────────────────────────────────

describe("SourceAdminService.mergeSources", () => {
  it("rejects merging a source into itself", async () => {
    const { repo, service } = makeRepo()
    await expectRejection(service.mergeSources("A", "A", "u", false), "name_conflict")
    expect(repo.checkMergeEligibility).not.toHaveBeenCalled()
  })

  it("rejects when either source is missing", async () => {
    const missingKeep = makeRepo({
      checkMergeEligibility: vi.fn(async () => ({
        keepExists: false,
        dropExists: true,
        keepCategory: null,
        dropCategory: "known",
      })),
    })
    await expectRejection(
      missingKeep.service.mergeSources("A", "B", "u", false),
      "source_not_found"
    )

    const missingDrop = makeRepo({
      checkMergeEligibility: vi.fn(async () => ({
        keepExists: true,
        dropExists: false,
        keepCategory: "known",
        dropCategory: null,
      })),
    })
    await expectRejection(
      missingDrop.service.mergeSources("A", "B", "u", false),
      "source_not_found"
    )
  })

  it("rejects merging across categories", async () => {
    const { service } = makeRepo({
      checkMergeEligibility: vi.fn(async () => ({
        keepExists: true,
        dropExists: true,
        keepCategory: "known",
        dropCategory: "toKnow",
      })),
    })
    await expectRejection(service.mergeSources("A", "B", "u", false), "category_mismatch")
  })

  it("dry run writes nothing", async () => {
    const { repo, service } = makeRepo({ countCuitsForSource: vi.fn(async () => 7) })
    const summary = await service.mergeSources("A", "B", "u", true)

    expect(summary).toMatchObject({ operation: "merge", affectedNodeCount: 7, dryRun: true })
    expect(repo.mergeSourceRelationshipsBatch).not.toHaveBeenCalled()
    expect(repo.finalizeSourceMerge).not.toHaveBeenCalled()
  })

  it("loops the batches and then drops the absorbed source", async () => {
    const { repo, service } = makeRepo({
      countCuitsForSource: vi.fn(async () => 1500),
      mergeSourceRelationshipsBatch: batches(1000, 500),
    })
    const summary = await service.mergeSources("A", "B", "u", false)

    expect(repo.mergeSourceRelationshipsBatch).toHaveBeenCalledTimes(3)
    expect(repo.mergeSourceRelationshipsBatch).toHaveBeenCalledWith("A", "B", 1000)
    expect(repo.finalizeSourceMerge).toHaveBeenCalledWith("B")
    expect(summary.updatedNodeCount).toBe(1500)
    expect(summary.createdSourceName).toBe("A")
    expect(summary.removedSourceName).toBe("B")
  })

  it("does not drop the source when a batch fails", async () => {
    const { repo, service } = makeRepo({
      mergeSourceRelationshipsBatch: vi.fn(async () => {
        throw new Error("boom")
      }),
    })
    await expect(service.mergeSources("A", "B", "u", false)).rejects.toThrow("boom")
    expect(repo.finalizeSourceMerge).not.toHaveBeenCalled()
    expect(logSourceOperationFailed).toHaveBeenCalled()
  })
})

// ─── deleteSource ─────────────────────────────────────────────────────────────

describe("SourceAdminService.deleteSource", () => {
  it("rejects when the source does not exist", async () => {
    const { service } = makeRepo({ checkSourceExists: vi.fn(async () => false) })
    await expectRejection(service.deleteSource("A", "u", false), "source_not_found")
  })

  it("dry run estimates the orphans without writing", async () => {
    const { repo, service } = makeRepo({
      countCuitsForSource: vi.fn(async () => 10),
      countOrphansForSource: vi.fn(async () => 3),
    })
    const summary = await service.deleteSource("A", "u", true)

    expect(summary).toMatchObject({
      operation: "delete",
      affectedNodeCount: 10,
      removedNodeCount: 3,
      updatedNodeCount: 7,
      dryRun: true,
    })
    expect(repo.deleteSourceRelationshipsBatch).not.toHaveBeenCalled()
    expect(repo.deleteSourceNode).not.toHaveBeenCalled()
    expect(repo.deleteOrphanedNodesBatch).not.toHaveBeenCalled()
  })

  it("captures the affected ids before detaching anything", async () => {
    const order: string[] = []
    const { service } = makeRepo({
      findCuitIdsForSource: vi.fn(async () => {
        order.push("capture")
        return ["1"]
      }),
      deleteSourceRelationshipsBatch: vi.fn(async () => {
        order.push("detach")
        return 0
      }),
    })
    await service.deleteSource("A", "u", false)
    expect(order).toEqual(["capture", "detach"])
  })

  it("detaches in batches, drops the source, then sweeps orphans in chunks", async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => String(i))
    const { repo, service } = makeRepo({
      countCuitsForSource: vi.fn(async () => 2500),
      findCuitIdsForSource: vi.fn(async () => ids),
      deleteSourceRelationshipsBatch: batches(1000, 1000, 500),
      deleteOrphanedNodesBatch: batches(4, 5, 1),
    })
    const summary = await service.deleteSource("A", "u", false)

    expect(repo.deleteSourceRelationshipsBatch).toHaveBeenCalledTimes(4)
    expect(repo.deleteSourceNode).toHaveBeenCalledWith("A")
    expect(repo.deleteOrphanedNodesBatch).toHaveBeenCalledTimes(3)
    expect(vi.mocked(repo.deleteOrphanedNodesBatch).mock.calls[0]![0]).toHaveLength(1000)
    expect(vi.mocked(repo.deleteOrphanedNodesBatch).mock.calls[2]![0]).toHaveLength(500)
    expect(summary.removedNodeCount).toBe(10)
    expect(summary.updatedNodeCount).toBe(2490)
  })

  it("sweeps orphans only after the source node is gone", async () => {
    const order: string[] = []
    const { service } = makeRepo({
      findCuitIdsForSource: vi.fn(async () => ["1"]),
      deleteSourceNode: vi.fn(async () => {
        order.push("dropSource")
      }),
      deleteOrphanedNodesBatch: vi.fn(async () => {
        order.push("sweep")
        return 0
      }),
    })
    await service.deleteSource("A", "u", false)
    expect(order).toEqual(["dropSource", "sweep"])
  })
})

// ─── addSourceToNode ──────────────────────────────────────────────────────────

describe("SourceAdminService.addSourceToNode", () => {
  it("rejects an unknown node", async () => {
    const { service } = makeRepo({
      checkAddEligibility: vi.fn(async () => ({ nodeExists: false, sourceExists: true })),
    })
    await expectRejection(service.addSourceToNode("1", "A", "u", false), "node_not_found")
  })

  it("rejects an unknown source", async () => {
    const { service } = makeRepo({
      checkAddEligibility: vi.fn(async () => ({ nodeExists: true, sourceExists: false })),
    })
    await expectRejection(service.addSourceToNode("1", "A", "u", false), "source_not_found")
  })

  it("dry run writes nothing", async () => {
    const { repo, service } = makeRepo()
    const summary = await service.addSourceToNode("1", "A", "u", true)

    expect(summary).toMatchObject({ operation: "add-source", dryRun: true, affectedNodeCount: 1 })
    expect(repo.addSourceToNode).not.toHaveBeenCalled()
  })

  it("attaches the source and reports one affected node", async () => {
    const { repo, service } = makeRepo()
    const summary = await service.addSourceToNode("1", "A", "u", false)

    expect(repo.addSourceToNode).toHaveBeenCalledWith("1", "A")
    expect(summary).toMatchObject({
      operation: "add-source",
      affectedNodeCount: 1,
      updatedNodeCount: 1,
      removedNodeCount: 0,
      dryRun: false,
    })
  })
})

// ─── moveSourceOnNode ─────────────────────────────────────────────────────────

describe("SourceAdminService.moveSourceOnNode", () => {
  it("is a no-op when origin and destination match", async () => {
    const { repo, service } = makeRepo()
    const summary = await service.moveSourceOnNode("1", "A", "A", "u", false)

    expect(summary.affectedNodeCount).toBe(0)
    expect(summary.updatedNodeCount).toBe(0)
    expect(repo.checkMoveEligibility).not.toHaveBeenCalled()
    expect(repo.moveSourceOnNode).not.toHaveBeenCalled()
  })

  it("rejects an unknown node", async () => {
    const { service } = makeRepo({
      checkMoveEligibility: vi.fn(async () => ({
        nodeExists: false,
        fromExists: false,
        toExists: true,
      })),
    })
    await expectRejection(service.moveSourceOnNode("1", "A", "B", "u", false), "node_not_found")
  })

  it("rejects an unknown destination source", async () => {
    const { service } = makeRepo({
      checkMoveEligibility: vi.fn(async () => ({
        nodeExists: true,
        fromExists: true,
        toExists: false,
      })),
    })
    await expectRejection(service.moveSourceOnNode("1", "A", "B", "u", false), "source_not_found")
  })

  it("rejects when the node is not attached to the origin source", async () => {
    const { service } = makeRepo({
      checkMoveEligibility: vi.fn(async () => ({
        nodeExists: true,
        fromExists: false,
        toExists: true,
      })),
    })
    await expectRejection(
      service.moveSourceOnNode("1", "A", "B", "u", false),
      "invalid_move_params"
    )
  })

  it("dry run writes nothing", async () => {
    const { repo, service } = makeRepo()
    const summary = await service.moveSourceOnNode("1", "A", "B", "u", true)

    expect(summary).toMatchObject({
      operation: "move-source",
      dryRun: true,
      createdSourceName: "B",
      removedSourceName: "A",
    })
    expect(repo.moveSourceOnNode).not.toHaveBeenCalled()
  })

  it("moves the node and reports both sources", async () => {
    const { repo, service } = makeRepo()
    const summary = await service.moveSourceOnNode("1", "A", "B", "u", false)

    expect(repo.moveSourceOnNode).toHaveBeenCalledWith("1", "A", "B")
    expect(summary).toMatchObject({
      operation: "move-source",
      affectedNodeCount: 1,
      createdSourceName: "B",
      removedSourceName: "A",
      dryRun: false,
    })
  })
})
