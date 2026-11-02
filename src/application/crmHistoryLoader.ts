import type { CrmWorkService } from "@application/CrmWorkService.js"
import type { HistoryStep } from "@domain/crmHistoryImport.js"

export interface HistoryLoadTally {
  done: number
  failed: number
}

export async function loadCompanyHistory(
  work: CrmWorkService,
  taxId: string,
  steps: readonly HistoryStep[],
  loader: string,
  onFailure: (step: HistoryStep, message: string) => void
): Promise<HistoryLoadTally> {
  const tally = { done: 0, failed: 0 }
  let openTaskId: string | null = null
  for (const step of steps) {
    try {
      const result = await work.importAction(
        {
          companyTaxId: taxId,
          doneBy: step.doneBy,
          date: step.date,
          description: step.description,
          contactIds: [],
          completesTaskIds: openTaskId ? [openTaskId] : [],
          nextTask: step.nextTask,
        },
        { username: loader, canAdminister: true }
      )
      openTaskId = result.nextTask?.id ?? null
      tally.done++
    } catch (err) {
      tally.failed++
      onFailure(step, err instanceof Error ? err.message : String(err))
    }
  }
  return tally
}
