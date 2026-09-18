import { describe, it, expect, beforeEach, vi } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { schemas } from "@schemas.js"

const findNode = vi.fn()

vi.mock("@infrastructure/neo4j/Neo4jSource.js", () => ({
  Neo4jSource: class {
    findNode = findNode
  },
}))

vi.mock("@auth/activityLogger.js", () => ({
  logCuitSearch: vi.fn(),
  logPathSearch: vi.fn(),
  logRelationshipAdded: vi.fn(),
  logRelationshipDeleted: vi.fn(),
  logNodeUpdated: vi.fn(),
  logNodeViewed: vi.fn(),
  logNodeRelationshipsViewed: vi.fn(),
  logMyBaseViewed: vi.fn(),
  logCompaniesViewed: vi.fn(),
  logBirthdaysViewed: vi.fn(),
  logToKnowViewed: vi.fn(),
  logAllMyNodesViewed: vi.fn(),
  logCrossingViewed: vi.fn(),
  logNameSearch: vi.fn(),
}))

const { default: graphRoutes } = await import("@routes/graph")

function debtor(operations: unknown[]) {
  return {
    taxId: "30645705943",
    businessName: "WEATHERFORD INTERNATIONAL DE ARGENTINA SA",
    phone: null,
    email: null,
    birthday: null,
    entryDate: null,
    exitDate: null,
    loadedAt: "11/09/2026",
    isKnown: false,
    isToKnow: true,
    inMyBase: true,
    sources: ["Deudores por financiera"],
    levelOfTrust: 0,
    trustReason: "",
    customFields: { financieraOperations: JSON.stringify(operations) },
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  for (const schema of Object.values(schemas)) {
    app.addSchema(schema)
  }
  await app.register(graphRoutes)
  await app.ready()
  return app
}

describe("GET /graph/node/:taxId — lenders", () => {
  let app: FastifyInstance

  beforeEach(async () => {
    findNode.mockReset()
    app = await buildApp()
  })

  it("sends each lender with its count and total", async () => {
    findNode.mockResolvedValue(
      debtor([
        { entityName: "FINARES S.A.", date: "01/04/2026", situation: "3", totalLoan: "2638000" },
        { entityName: "MARIAS CAPITAL SA", date: "01/05/2026", situation: "1", totalLoan: "500000" },
        { entityName: "FINARES S.A.", date: "01/05/2026", situation: "3", totalLoan: "1000000" },
      ])
    )
    const res = await app.inject({ method: "GET", url: "/graph/node/30645705943" })
    expect(res.statusCode).toBe(200)
    expect(res.json().financieraLenders).toEqual([
      { entityName: "FINARES S.A.", operationCount: 2, totalLoan: 3638000 },
      { entityName: "MARIAS CAPITAL SA", operationCount: 1, totalLoan: 500000 },
    ])
  })

  it("sends an empty list for a CUIT that owes no lender", async () => {
    findNode.mockResolvedValue({ ...debtor([]), customFields: {} })
    const res = await app.inject({ method: "GET", url: "/graph/node/30645705943" })
    expect(res.json().financieraLenders).toEqual([])
  })

  it("keeps sending the months it already sent", async () => {
    findNode.mockResolvedValue(
      debtor([{ entityName: "FINARES S.A.", date: "01/04/2026", situation: "3", totalLoan: "1" }])
    )
    const res = await app.inject({ method: "GET", url: "/graph/node/30645705943" })
    expect(res.json().financieraMonths).toEqual(["2026-04"])
  })

  it("answers 404 for a CUIT that is not in the graph", async () => {
    findNode.mockResolvedValue(null)
    const res = await app.inject({ method: "GET", url: "/graph/node/20000000001" })
    expect(res.statusCode).toBe(404)
  })
})
