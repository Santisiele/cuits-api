/** Scripts run by hand, so the activity log can show them. */
export const ManualRunQueries = {
  START_MANUAL_RUN: `
    CREATE (:ManualRun {
      id: $id,
      script: $script,
      args: $args,
      by: $by,
      startedAt: $startedAt,
      finishedAt: null,
      status: $status,
      exitCode: null
    })
  `,

  FINISH_MANUAL_RUN: `
    MATCH (run:ManualRun {id: $id})
    SET run.status = $status, run.exitCode = $exitCode, run.finishedAt = $finishedAt
  `,

  LIST_MANUAL_RUNS: `
    MATCH (run:ManualRun)
    RETURN run
    ORDER BY run.startedAt
  `,
} as const
