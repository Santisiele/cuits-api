import type { IGraphRepository } from "@ports/interfaces.js"
import type {
  TrustLevelColor,
  TrustLevelInfo,
  TrustLevelOperationSummary,
  TrustLevelRejection,
} from "@domain/entities.js"
import { isTrustLevelColor } from "@domain/entities.js"

export class TrustLevelAdminError extends Error {
  constructor(readonly reason: TrustLevelRejection, message: string) {
    super(message)
    this.name = "TrustLevelAdminError"
  }
}

const MAX_LABEL_LENGTH = 40

export class TrustLevelAdminService {
  constructor(private readonly repository: IGraphRepository) {}

  listLevels(): Promise<TrustLevelInfo[]> {
    return this.repository.findTrustLevels()
  }

  async createLevel(
    rawLabel: string,
    color: string,
    dryRun: boolean
  ): Promise<TrustLevelOperationSummary> {
    const label = this.validateLabel(rawLabel)
    this.validateColor(color)
    await this.rejectLabelConflict(label, null)

    if (dryRun) {
      return {
        operation: "create-level",
        value: 0,
        label,
        affectedNodeCount: 0,
        dryRun: true,
        message: `Preview: level "${label}" would be created`,
      }
    }

    const value = await this.repository.createTrustLevel(label, color as TrustLevelColor)
    return {
      operation: "create-level",
      value,
      label,
      affectedNodeCount: 0,
      dryRun: false,
      message: `Created level "${label}"`,
    }
  }

  async updateLevel(
    value: number,
    rawLabel: string | undefined,
    color: string | undefined,
    dryRun: boolean
  ): Promise<TrustLevelOperationSummary> {
    this.rejectReserved(value)
    const existing = await this.requireLevel(value)

    const label = rawLabel === undefined ? null : this.validateLabel(rawLabel)
    if (color !== undefined) this.validateColor(color)
    if (label !== null) await this.rejectLabelConflict(label, value)

    const affectedNodeCount = await this.repository.countCuitsForTrustLevel(value)
    const finalLabel = label ?? existing.label

    if (dryRun) {
      return {
        operation: "update-level",
        value,
        label: finalLabel,
        affectedNodeCount,
        dryRun: true,
        message: `Preview: level "${existing.label}" would become "${finalLabel}", affecting ${affectedNodeCount} CUITs`,
      }
    }

    await this.repository.updateTrustLevel(
      value,
      label,
      color === undefined ? null : (color as TrustLevelColor)
    )
    return {
      operation: "update-level",
      value,
      label: finalLabel,
      affectedNodeCount,
      dryRun: false,
      message: `Updated level "${finalLabel}", affecting ${affectedNodeCount} CUITs`,
    }
  }

  async deleteLevel(value: number, dryRun: boolean): Promise<TrustLevelOperationSummary> {
    this.rejectReserved(value)
    const existing = await this.requireLevel(value)
    const affectedNodeCount = await this.repository.countCuitsForTrustLevel(value)

    if (dryRun) {
      return {
        operation: "delete-level",
        value,
        label: existing.label,
        affectedNodeCount,
        dryRun: true,
        message: `Preview: deleting "${existing.label}" would move ${affectedNodeCount} CUITs back to no level`,
      }
    }

    const cleared = await this.repository.deleteTrustLevel(value)
    return {
      operation: "delete-level",
      value,
      label: existing.label,
      affectedNodeCount: cleared,
      dryRun: false,
      message: `Deleted "${existing.label}": ${cleared} CUITs moved back to no level`,
    }
  }

  private validateLabel(raw: string): string {
    const label = raw.trim()
    if (!label) {
      throw new TrustLevelAdminError("invalid_label", "The label cannot be empty")
    }
    if (label.length > MAX_LABEL_LENGTH) {
      throw new TrustLevelAdminError(
        "invalid_label",
        `The label cannot be longer than ${MAX_LABEL_LENGTH} characters`
      )
    }
    return label
  }

  private validateColor(color: string): void {
    if (!isTrustLevelColor(color)) {
      throw new TrustLevelAdminError("invalid_color", `"${color}" is not an available color`)
    }
  }

  private rejectReserved(value: number): void {
    if (value === 0) {
      throw new TrustLevelAdminError(
        "reserved_level",
        "Level 0 stands for having no level and cannot be edited or deleted"
      )
    }
  }

  private async requireLevel(value: number): Promise<TrustLevelInfo> {
    const existing = await this.repository.findTrustLevel(value)
    if (!existing) {
      throw new TrustLevelAdminError("level_not_found", `Level ${value} does not exist`)
    }
    return existing
  }

  private async rejectLabelConflict(label: string, allowedValue: number | null): Promise<void> {
    const taken = await this.repository.findTrustLevelValueByLabel(label)
    if (taken !== null && taken !== allowedValue) {
      throw new TrustLevelAdminError("label_conflict", `The label "${label}" is already in use`)
    }
  }
}
