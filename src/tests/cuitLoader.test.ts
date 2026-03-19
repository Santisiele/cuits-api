import { describe, it, expect, vi } from "vitest"
import { filterValidCuits, loadCuitsIntoNeo4j } from "@helpers/cuitLoader"
import type { CuitRecord } from "@helpers/cuitLoader"
import type { Session } from "neo4j-driver"

// ---- Test data ----

const rawRecords = [
  { "CUIT": "20-12345678-9", "Nombre completo": "Juan Perez", "E-mail": "juan@test.com", "Telefono": "123" },
  { "CUIT": "ERROR - NOT FOUND", "Nombre completo": "Sin CUIT", "E-mail": "", "Telefono": "" },
  { "CUIT": "DUPLICATES: 20-111, 20-222", "Nombre completo": "Homonimo", "E-mail": "", "Telefono": "" },
  { "CUIT": "30-98765432-1", "Nombre completo": "Empresa SA", "E-mail": "empresa@test.com", "Telefono": "456" },
  { "CUIT": "", "Nombre completo": "Sin datos", "E-mail": "", "Telefono": "" },
]

// ---- filterValidCuits tests ----

describe("filterValidCuits", () => {
  it("returns only records with valid CUIT format", () => {
    const result = filterValidCuits(rawRecords, "csv-poseidon")
    expect(result).toHaveLength(2)
  })

  it("maps fields correctly", () => {
    const result = filterValidCuits(rawRecords, "csv-poseidon")
    expect(result[0]).toEqual({
      id: "20-12345678-9",
      name: "Juan Perez",
      email: "juan@test.com",
      phone: "123",
      source: "csv-poseidon",
    })
  })

  it("sets the source correctly", () => {
    const result = filterValidCuits(rawRecords, "csv-otra-fuente")
    expect(result.every((r) => r.source === "csv-otra-fuente")).toBe(true)
  })

  it("returns empty array when no valid CUITs", () => {
    const result = filterValidCuits([rawRecords[1]!, rawRecords[2]!], "csv-poseidon")
    expect(result).toHaveLength(0)
  })

  it("ignores empty CUIT fields", () => {
    const result = filterValidCuits([rawRecords[4]!], "csv-poseidon")
    expect(result).toHaveLength(0)
  })
})

// ---- loadCuitsIntoNeo4j tests ----

describe("loadCuitsIntoNeo4j", () => {
  const mockSession = {
    run: vi.fn().mockResolvedValue({}),
  } as unknown as Session

  it("calls session.run once per CUIT", async () => {
    const cuits: CuitRecord[] = [
      { id: "20-12345678-9", name: "Juan", email: "j@test.com", phone: "123", source: "csv-poseidon" },
      { id: "30-98765432-1", name: "Empresa", email: "e@test.com", phone: "456", source: "csv-poseidon" },
    ]

    await loadCuitsIntoNeo4j(cuits, mockSession)
    expect(mockSession.run).toHaveBeenCalledTimes(2)
  })

  it("passes correct params to session.run", async () => {
    const cuit: CuitRecord = {
      id: "20-12345678-9",
      name: "Juan",
      email: "j@test.com",
      phone: "123",
      source: "csv-poseidon",
    }

    vi.clearAllMocks()
    await loadCuitsIntoNeo4j([cuit], mockSession)

    expect(mockSession.run).toHaveBeenCalledWith(
      expect.stringContaining("MERGE"),
      cuit
    )
  })

  it("does nothing when cuits array is empty", async () => {
    vi.clearAllMocks()
    await loadCuitsIntoNeo4j([], mockSession)
    expect(mockSession.run).not.toHaveBeenCalled()
  })
})