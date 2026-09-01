import { describe, it, expect } from "vitest"
import { extractActivityMonths } from "@domain/activityMonths"

/** Builds the customFields shape a loader persists. */
function withOperations(operations: unknown): Record<string, unknown> {
  return { operations: JSON.stringify(operations) }
}

describe("extractActivityMonths", () => {
  it("returns the month of a single operation", () => {
    expect(extractActivityMonths(withOperations([{ date: "01/05/2026" }]))).toEqual(["2026-05"])
  })

  it("collapses several operations in the same month into one entry", () => {
    const months = extractActivityMonths(
      withOperations([{ date: "01/05/2026" }, { date: "01/05/2026" }, { date: "01/05/2026" }])
    )
    expect(months).toEqual(["2026-05"])
  })

  it("sorts distinct months newest first", () => {
    const months = extractActivityMonths(
      withOperations([{ date: "01/01/2026" }, { date: "01/06/2026" }, { date: "01/04/2026" }])
    )
    expect(months).toEqual(["2026-06", "2026-04", "2026-01"])
  })

  it("orders across years, not just within one", () => {
    const months = extractActivityMonths(
      withOperations([{ date: "01/02/2025" }, { date: "01/12/2024" }, { date: "01/01/2026" }])
    )
    expect(months).toEqual(["2026-01", "2025-02", "2024-12"])
  })

  it("skips operations whose period cell was blank in the source file", () => {
    const months = extractActivityMonths(
      withOperations([{ date: "" }, { date: "01/05/2026" }, {}])
    )
    expect(months).toEqual(["2026-05"])
  })

  it("ignores dates that are not dd/mm/yyyy", () => {
    const months = extractActivityMonths(
      withOperations([{ date: "2026-05-01" }, { date: "mayo" }, { date: "01/05/2026" }])
    )
    expect(months).toEqual(["2026-05"])
  })

  // A corrupt or foreign node must not break the lookup that reads it.
  it.each([
    ["no operations field", {}],
    ["operations is not a string", { operations: 42 }],
    ["operations is empty", { operations: "" }],
    ["operations is not valid JSON", { operations: "{not json" }],
    ["operations is not an array", { operations: '{"date":"01/05/2026"}' }],
    ["operations is an empty array", { operations: "[]" }],
  ])("returns an empty array when %s", (_label, customFields) => {
    expect(extractActivityMonths(customFields as Record<string, unknown>)).toEqual([])
  })

  it("accepts a single-digit day, which the loaders could emit", () => {
    expect(extractActivityMonths(withOperations([{ date: "1/05/2026" }]))).toEqual(["2026-05"])
  })
})
