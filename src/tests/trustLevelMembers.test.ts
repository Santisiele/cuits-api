import { describe, it, expect, vi, beforeEach } from "vitest"
import type { TrustLevelInfo, TrustLevelMember } from "@domain/entities"

const { TrustLevelAdminService, TrustLevelAdminError } = await import(
  "@application/TrustLevelAdminService"
)

const LEVEL: TrustLevelInfo = {
  value: 4,
  label: "Interesante",
  color: "green",
  nodeCount: 0,
  description: "Vale la pena",
}

function member(taxId: string, trustReason = ""): TrustLevelMember {
  return {
    taxId,
    businessName: `Empresa ${taxId}`,
    sources: ["Bolsa"],
    relationshipCount: 0,
    isKnown: false,
    isToKnow: true,
    trustReason,
  }
}

function makeRepo() {
  return {
    findTrustLevel: vi.fn(async (): Promise<TrustLevelInfo | null> => LEVEL),
    findTrustLevelMembers: vi.fn(async (_value: number): Promise<TrustLevelMember[]> => []),
  }
}

function makeService(repo: ReturnType<typeof makeRepo>) {
  return new TrustLevelAdminService(repo as never)
}

describe("TrustLevelAdminService.listMembers", () => {
  let repo: ReturnType<typeof makeRepo>

  beforeEach(() => {
    repo = makeRepo()
  })

  it("returns the level with the CUITs that carry it", async () => {
    repo.findTrustLevelMembers.mockResolvedValue([member("30500904557"), member("30714208671")])
    const result = await makeService(repo).listMembers(4)
    expect(result.level.label).toBe("Interesante")
    expect(result.members.map((m) => m.taxId)).toEqual(["30500904557", "30714208671"])
  })

  it("counts the level from the list it actually returns", async () => {
    repo.findTrustLevelMembers.mockResolvedValue([member("30500904557"), member("30714208671")])
    const result = await makeService(repo).listMembers(4)
    expect(result.level.nodeCount).toBe(2)
  })

  it("asks the repository for the level it was given", async () => {
    await makeService(repo).listMembers(4)
    expect(repo.findTrustLevelMembers).toHaveBeenCalledWith(4)
  })

  it("keeps the reason each CUIT was given its level", async () => {
    repo.findTrustLevelMembers.mockResolvedValue([member("30500904557", "de cordoba")])
    const result = await makeService(repo).listMembers(4)
    expect(result.members[0]!.trustReason).toBe("de cordoba")
  })

  it("returns an empty list for a level nobody has", async () => {
    const result = await makeService(repo).listMembers(4)
    expect(result.members).toEqual([])
    expect(result.level.nodeCount).toBe(0)
  })

  it("refuses level 0, which stands for having no level", async () => {
    await expect(makeService(repo).listMembers(0)).rejects.toMatchObject({ reason: "reserved_level" })
  })

  it("does not touch the graph for level 0", async () => {
    await makeService(repo).listMembers(0).catch(() => undefined)
    expect(repo.findTrustLevel).not.toHaveBeenCalled()
    expect(repo.findTrustLevelMembers).not.toHaveBeenCalled()
  })

  it("answers level_not_found for a level that does not exist", async () => {
    repo.findTrustLevel.mockResolvedValue(null)
    const error = await makeService(repo).listMembers(99).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TrustLevelAdminError)
    expect(error).toMatchObject({ reason: "level_not_found" })
  })

  it("does not list members of a level that does not exist", async () => {
    repo.findTrustLevel.mockResolvedValue(null)
    await makeService(repo).listMembers(99).catch(() => undefined)
    expect(repo.findTrustLevelMembers).not.toHaveBeenCalled()
  })
})
