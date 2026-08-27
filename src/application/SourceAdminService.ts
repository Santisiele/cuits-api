import type { IGraphRepository } from "@ports/interfaces.js"
import type {
  OperationSummary,
  SourceAdminOperation,
  SourceAdminRejection,
} from "@domain/entities.js"
import {
  logSourceOperationInitiated,
  logSourceOperationCompleted,
  logSourceOperationFailed,
} from "@auth/activityLogger.js"

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Aura caps memory per transaction. Every operation here can touch thousands
 * of CUITs, so the work is split into batches small enough to commit
 * individually; a failure then leaves the earlier batches applied instead of
 * rolling back hours of work.
 */
const BATCH_SIZE = 1000

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Raised when an operation is rejected before touching the graph.
 * Route handlers map `reason` to an HTTP status code.
 */
export class SourceAdminError extends Error {
  constructor(
    public readonly reason: SourceAdminRejection,
    message: string
  ) {
    super(message)
    this.name = "SourceAdminError"
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Application service for source administration.
 *
 * Every operation follows the same shape: validate, branch on dry run, log
 * that it started, execute in batches, log that it finished. The batching
 * loop lives here rather than in the repository so progress and partial
 * failures stay visible to the caller.
 *
 * A dry run never writes and never needs step-up authentication, so it is
 * safe to expose as a preview to any logged-in user.
 */
export class SourceAdminService {
  constructor(private readonly repository: IGraphRepository) {}

  // ─── Rename ─────────────────────────────────────────────────────────────

  async renameSource(
    oldName: string,
    newName: string,
    username: string,
    dryRun: boolean
  ): Promise<OperationSummary> {
    const trimmedNewName = newName.trim()
    if (!trimmedNewName) {
      throw new SourceAdminError("name_conflict", "El nuevo nombre no puede estar vacío")
    }

    const eligibility = await this.repository.checkRenameEligibility(oldName, trimmedNewName)
    if (!eligibility.sourceExists) {
      throw new SourceAdminError("source_not_found", `La fuente "${oldName}" no existe`)
    }
    if (eligibility.newNameExists) {
      throw new SourceAdminError(
        "name_conflict",
        `El nombre "${trimmedNewName}" ya está en uso. Usá merge en su lugar.`
      )
    }

    const affectedNodeCount = await this.repository.countCuitsForSource(oldName)

    if (dryRun) {
      return {
        operation: "rename",
        affectedNodeCount,
        removedNodeCount: 0,
        updatedNodeCount: affectedNodeCount,
        createdSourceName: trimmedNewName,
        removedSourceName: oldName,
        dryRun: true,
        message: `Preview: se renombraría "${oldName}" a "${trimmedNewName}" afectando ${affectedNodeCount} nodos.`,
      }
    }

    const startedAt = Date.now()
    logSourceOperationInitiated({
      event: "source_rename_initiated",
      username,
      sourceName: oldName,
      operationParams: { newName: trimmedNewName },
      affectedNodeCount,
    })

    let updatedTotal = 0
    try {
      await this.repository.renameSourceNode(oldName, trimmedNewName)

      let batchProcessed = 0
      do {
        batchProcessed = await this.repository.updateSourcesArrayForRenameBatch(
          oldName,
          trimmedNewName,
          BATCH_SIZE
        )
        updatedTotal += batchProcessed
      } while (batchProcessed > 0)

      const summary: OperationSummary = {
        operation: "rename",
        affectedNodeCount,
        removedNodeCount: 0,
        updatedNodeCount: updatedTotal,
        createdSourceName: trimmedNewName,
        removedSourceName: oldName,
        dryRun: false,
        message: `Se renombró "${oldName}" a "${trimmedNewName}" afectando ${updatedTotal} nodos.`,
      }

      logSourceOperationCompleted({
        event: "source_rename_completed",
        username,
        sourceName: trimmedNewName,
        finalSummary: summary,
        durationMs: Date.now() - startedAt,
      })

      return summary
    } catch (err) {
      this.logFailure("source_rename_failed", username, oldName, err, {
        newName: trimmedNewName,
        updatedTotal,
      })
      throw err
    }
  }

  // ─── Merge ──────────────────────────────────────────────────────────────

  async mergeSources(
    sourceToKeep: string,
    sourceToDrop: string,
    username: string,
    dryRun: boolean
  ): Promise<OperationSummary> {
    if (sourceToKeep === sourceToDrop) {
      throw new SourceAdminError(
        "name_conflict",
        "No se puede mergear una fuente consigo misma"
      )
    }

    const eligibility = await this.repository.checkMergeEligibility(sourceToKeep, sourceToDrop)
    if (!eligibility.keepExists) {
      throw new SourceAdminError("source_not_found", `La fuente "${sourceToKeep}" no existe`)
    }
    if (!eligibility.dropExists) {
      throw new SourceAdminError("source_not_found", `La fuente "${sourceToDrop}" no existe`)
    }
    if (eligibility.keepCategory !== eligibility.dropCategory) {
      throw new SourceAdminError(
        "category_mismatch",
        `No se pueden mergear fuentes de distinta categoría: "${sourceToKeep}" es ${eligibility.keepCategory} y "${sourceToDrop}" es ${eligibility.dropCategory}`
      )
    }

    const affectedNodeCount = await this.repository.countCuitsForSource(sourceToDrop)

    if (dryRun) {
      return {
        operation: "merge",
        affectedNodeCount,
        removedNodeCount: 0,
        updatedNodeCount: affectedNodeCount,
        createdSourceName: sourceToKeep,
        removedSourceName: sourceToDrop,
        dryRun: true,
        message: `Preview: se mergearía "${sourceToDrop}" dentro de "${sourceToKeep}" moviendo ${affectedNodeCount} nodos.`,
      }
    }

    const startedAt = Date.now()
    logSourceOperationInitiated({
      event: "source_merge_initiated",
      username,
      sourceName: sourceToDrop,
      operationParams: { sourceToKeep, sourceToDrop },
      affectedNodeCount,
    })

    let updatedTotal = 0
    try {
      let batchProcessed = 0
      do {
        batchProcessed = await this.repository.mergeSourceRelationshipsBatch(
          sourceToKeep,
          sourceToDrop,
          BATCH_SIZE
        )
        updatedTotal += batchProcessed
      } while (batchProcessed > 0)

      await this.repository.finalizeSourceMerge(sourceToDrop)

      const summary: OperationSummary = {
        operation: "merge",
        affectedNodeCount,
        removedNodeCount: 0,
        updatedNodeCount: updatedTotal,
        createdSourceName: sourceToKeep,
        removedSourceName: sourceToDrop,
        dryRun: false,
        message: `Se mergeó "${sourceToDrop}" dentro de "${sourceToKeep}" moviendo ${updatedTotal} nodos.`,
      }

      logSourceOperationCompleted({
        event: "source_merge_completed",
        username,
        sourceName: sourceToKeep,
        finalSummary: summary,
        durationMs: Date.now() - startedAt,
      })

      return summary
    } catch (err) {
      this.logFailure("source_merge_failed", username, sourceToDrop, err, {
        sourceToKeep,
        updatedTotal,
      })
      throw err
    }
  }

  // ─── Delete ─────────────────────────────────────────────────────────────

  async deleteSource(
    sourceName: string,
    username: string,
    dryRun: boolean
  ): Promise<OperationSummary> {
    const exists = await this.repository.checkSourceExists(sourceName)
    if (!exists) {
      throw new SourceAdminError("source_not_found", `La fuente "${sourceName}" no existe`)
    }

    const affectedNodeCount = await this.repository.countCuitsForSource(sourceName)

    if (dryRun) {
      const estimatedOrphans = await this.repository.countOrphansForSource(sourceName)
      return {
        operation: "delete",
        affectedNodeCount,
        removedNodeCount: estimatedOrphans,
        updatedNodeCount: affectedNodeCount - estimatedOrphans,
        removedSourceName: sourceName,
        dryRun: true,
        message: `Preview: se borraría "${sourceName}" afectando ${affectedNodeCount} nodos, de los cuales ${estimatedOrphans} quedarían sin fuentes y se eliminarían.`,
      }
    }

    const startedAt = Date.now()
    logSourceOperationInitiated({
      event: "source_delete_initiated",
      username,
      sourceName,
      operationParams: { sourceName },
      affectedNodeCount,
    })

    let detachedTotal = 0
    let removedTotal = 0
    try {
      /**
       * Captured before detaching: once the relationships are gone there is
       * no way to tell which nodes this operation orphaned apart from ones
       * that were already dangling, and the sweep must not touch those.
       */
      const affectedIds = await this.repository.findCuitIdsForSource(sourceName)

      let batchProcessed = 0
      do {
        batchProcessed = await this.repository.deleteSourceRelationshipsBatch(
          sourceName,
          BATCH_SIZE
        )
        detachedTotal += batchProcessed
      } while (batchProcessed > 0)

      await this.repository.deleteSourceNode(sourceName)

      for (const batch of chunk(affectedIds, BATCH_SIZE)) {
        removedTotal += await this.repository.deleteOrphanedNodesBatch(batch)
      }

      const summary: OperationSummary = {
        operation: "delete",
        affectedNodeCount,
        removedNodeCount: removedTotal,
        updatedNodeCount: detachedTotal - removedTotal,
        removedSourceName: sourceName,
        dryRun: false,
        message: `Se borró "${sourceName}": ${detachedTotal} nodos afectados, ${removedTotal} eliminados por quedar sin fuentes.`,
      }

      logSourceOperationCompleted({
        event: "source_delete_completed",
        username,
        sourceName,
        finalSummary: summary,
        durationMs: Date.now() - startedAt,
      })

      return summary
    } catch (err) {
      this.logFailure("source_delete_failed", username, sourceName, err, {
        detachedTotal,
        removedTotal,
      })
      throw err
    }
  }

  // ─── Node level ─────────────────────────────────────────────────────────

  async addSourceToNode(
    taxId: string,
    sourceName: string,
    username: string,
    dryRun: boolean
  ): Promise<OperationSummary> {
    const eligibility = await this.repository.checkAddEligibility(taxId, sourceName)
    if (!eligibility.nodeExists) {
      throw new SourceAdminError("node_not_found", `El CUIT ${taxId} no existe`)
    }
    if (!eligibility.sourceExists) {
      throw new SourceAdminError("source_not_found", `La fuente "${sourceName}" no existe`)
    }

    if (dryRun) {
      return this.nodeSummary("add-source", sourceName, false, {
        message: `Preview: se agregaría la fuente "${sourceName}" al CUIT ${taxId}.`,
        dryRun: true,
      })
    }

    const startedAt = Date.now()
    logSourceOperationInitiated({
      event: "node_source_change_initiated",
      username,
      sourceName,
      operationParams: { taxId, mode: "add" },
      affectedNodeCount: 1,
    })

    try {
      await this.repository.addSourceToNode(taxId, sourceName)

      const summary = this.nodeSummary("add-source", sourceName, false, {
        message: `Se agregó la fuente "${sourceName}" al CUIT ${taxId}.`,
        dryRun: false,
      })

      logSourceOperationCompleted({
        event: "node_source_change_completed",
        username,
        sourceName,
        finalSummary: summary,
        durationMs: Date.now() - startedAt,
      })

      return summary
    } catch (err) {
      this.logFailure("node_source_change_failed", username, sourceName, err, {
        taxId,
        mode: "add",
      })
      throw err
    }
  }

  async moveSourceOnNode(
    taxId: string,
    fromSource: string,
    toSource: string,
    username: string,
    dryRun: boolean
  ): Promise<OperationSummary> {
    if (fromSource === toSource) {
      return this.nodeSummary("move-source", toSource, true, {
        message: `El CUIT ${taxId} ya está en "${toSource}", no hubo cambios.`,
        dryRun,
      })
    }

    const eligibility = await this.repository.checkMoveEligibility(taxId, fromSource, toSource)
    if (!eligibility.nodeExists) {
      throw new SourceAdminError("node_not_found", `El CUIT ${taxId} no existe`)
    }
    if (!eligibility.toExists) {
      throw new SourceAdminError("source_not_found", `La fuente "${toSource}" no existe`)
    }
    if (!eligibility.fromExists) {
      throw new SourceAdminError(
        "invalid_move_params",
        `El CUIT ${taxId} no pertenece a la fuente "${fromSource}"`
      )
    }

    if (dryRun) {
      return this.nodeSummary("move-source", toSource, false, {
        message: `Preview: se movería el CUIT ${taxId} de "${fromSource}" a "${toSource}".`,
        dryRun: true,
        removedSourceName: fromSource,
      })
    }

    const startedAt = Date.now()
    logSourceOperationInitiated({
      event: "node_source_change_initiated",
      username,
      sourceName: toSource,
      operationParams: { taxId, mode: "move", fromSource },
      affectedNodeCount: 1,
    })

    try {
      await this.repository.moveSourceOnNode(taxId, fromSource, toSource)

      const summary = this.nodeSummary("move-source", toSource, false, {
        message: `Se movió el CUIT ${taxId} de "${fromSource}" a "${toSource}".`,
        dryRun: false,
        removedSourceName: fromSource,
      })

      logSourceOperationCompleted({
        event: "node_source_change_completed",
        username,
        sourceName: toSource,
        finalSummary: summary,
        durationMs: Date.now() - startedAt,
      })

      return summary
    } catch (err) {
      this.logFailure("node_source_change_failed", username, toSource, err, {
        taxId,
        mode: "move",
        fromSource,
      })
      throw err
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * Builds the summary for the single-node operations, which always touch
   * exactly one CUIT and never remove anything.
   */
  private nodeSummary(
    operation: SourceAdminOperation,
    createdSourceName: string,
    noop: boolean,
    extra: { message: string; dryRun: boolean; removedSourceName?: string }
  ): OperationSummary {
    return {
      operation,
      affectedNodeCount: noop ? 0 : 1,
      removedNodeCount: 0,
      updatedNodeCount: noop ? 0 : 1,
      createdSourceName,
      ...(extra.removedSourceName === undefined
        ? {}
        : { removedSourceName: extra.removedSourceName }),
      dryRun: extra.dryRun,
      message: extra.message,
    }
  }

  private logFailure(
    event: string,
    username: string,
    sourceName: string,
    err: unknown,
    partialProgress: Record<string, unknown>
  ): void {
    logSourceOperationFailed({
      event,
      username,
      sourceName,
      error: err instanceof Error ? err.message : String(err),
      partialProgress,
    })
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Splits a list into fixed-size chunks, preserving order. */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}
