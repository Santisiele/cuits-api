export interface ImportedCompany {
  taxId: string
  businessName: string
  crmBrand: string | null
  crmProduct: string | null
  crmOrigin: string | null
}

export interface ParsedCompanyList {
  companies: ImportedCompany[]
  withoutCuit: string[]
  invalidCuit: { businessName: string; cuit: string }[]
  conflicting: { businessName: string; cuits: string[] }[]
}

type Row = Record<string, unknown>

function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function joined(values: Set<string>): string | null {
  return values.size === 0 ? null : [...values].join(" / ")
}

export function parseCompanyList(rows: Row[]): ParsedCompanyList {
  const byName = new Map<string, { cuits: Set<string>; brands: Set<string>; products: Set<string>; origins: Set<string> }>()

  for (const row of rows) {
    const businessName = text(row["Empresa"])
    if (!businessName) continue
    const entry = byName.get(businessName) ?? { cuits: new Set(), brands: new Set(), products: new Set(), origins: new Set() }
    const cuit = text(row["CUIT"]).replace(/\D/g, "")
    if (cuit) entry.cuits.add(cuit)
    const brand = text(row["Marca"])
    const product = text(row["Producto o Servicio"])
    const origin = text(row["Origen"])
    if (brand) entry.brands.add(brand)
    if (product) entry.products.add(product)
    if (origin) entry.origins.add(origin)
    byName.set(businessName, entry)
  }

  const result: ParsedCompanyList = { companies: [], withoutCuit: [], invalidCuit: [], conflicting: [] }
  const seen = new Set<string>()

  for (const [businessName, entry] of byName) {
    if (entry.cuits.size === 0) {
      result.withoutCuit.push(businessName)
      continue
    }
    if (entry.cuits.size > 1) {
      result.conflicting.push({ businessName, cuits: [...entry.cuits] })
      continue
    }
    const taxId = [...entry.cuits][0]!
    if (taxId.length !== 11) {
      result.invalidCuit.push({ businessName, cuit: taxId })
      continue
    }
    if (seen.has(taxId)) {
      result.conflicting.push({ businessName, cuits: [taxId] })
      continue
    }
    seen.add(taxId)
    result.companies.push({
      taxId,
      businessName,
      crmBrand: joined(entry.brands),
      crmProduct: joined(entry.products),
      crmOrigin: joined(entry.origins),
    })
  }

  return result
}

export function isProductionUri(uri: string): boolean {
  return /\.databases\.neo4j\.io/i.test(uri)
}
