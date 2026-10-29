/** Companies in the CRM: membership, origin sources, closing and removal. */
export const CrmCompanyQueries = {
  CRM_FIND_CUIT_STATE: `
    OPTIONAL MATCH (c:CUIT {id: $taxId})
    RETURN c IS NOT NULL AS exists,
           coalesce(c.crmCompany, false) AS inCrm,
           c.crmArchivedAt IS NOT NULL AS archived,
           c.nosisSearchedAt IS NOT NULL AS nosisSearched,
           CASE WHEN c IS NULL THEN false
                ELSE EXISTS { MATCH (c)-[:HAS_SOURCE]->(:Source {category: "known"}) }
           END AS inKnownSource
  `,

  CRM_ADD_CUIT: `
    MERGE (c:CUIT {id: $taxId})
    ON CREATE SET c.businessName = $businessName, c.inMyBase = false, c.crmCreated = true
    SET c.businessName = CASE WHEN coalesce(c.businessName, "") = "" THEN coalesce($businessName, "") ELSE c.businessName END,
        c.crmCompany = CASE WHEN $asCompany THEN true ELSE coalesce(c.crmCompany, false) END,
        c.crmBrand = CASE WHEN $asCompany THEN $crmBrand ELSE c.crmBrand END,
        c.crmProduct = CASE WHEN $asCompany THEN $crmProduct ELSE c.crmProduct END,
        c.crmOrigin = CASE WHEN $asCompany THEN $crmOrigin ELSE c.crmOrigin END,
        c.crmOriginSource = CASE WHEN $asCompany THEN $originSource ELSE c.crmOriginSource END,
        c.crmAddedAt = CASE WHEN $asCompany OR c.crmAddedAt IS NULL THEN $at ELSE c.crmAddedAt END,
        c.crmAddedBy = CASE WHEN $asCompany OR c.crmAddedBy IS NULL THEN $by ELSE c.crmAddedBy END,
        c.crmArchivedAt = CASE WHEN $asCompany THEN null ELSE c.crmArchivedAt END,
        c.nosisPending = CASE WHEN $markNosisPending THEN true ELSE c.nosisPending END
  `,

  CRM_ATTACH_SOURCE: `
    MATCH (c:CUIT {id: $taxId})
    MATCH (s:Source {name: $sourceName})
    MERGE (c)-[link:HAS_SOURCE]->(s)
    ON CREATE SET link.viaCrm = true
    SET c.sources = CASE
      WHEN $sourceName IN coalesce(c.sources, []) THEN c.sources
      ELSE coalesce(c.sources, []) + $sourceName
    END
    WITH c
    MATCH (c)-[:HAS_SOURCE]->(remaining:Source)
    WITH c, collect(remaining.category) AS categories
    SET c.isKnown  = "known"  IN categories,
        c.isToKnow = "toKnow" IN categories,
        c.inMyBase = size(categories) > 0
  `,

  CRM_DETACH_SOURCE: `
    MATCH (c:CUIT {id: $taxId})-[r:HAS_SOURCE {viaCrm: true}]->(:Source {name: $sourceName})
    DELETE r
    WITH c
    SET c.sources = [x IN coalesce(c.sources, []) WHERE x <> $sourceName]
    WITH c
    OPTIONAL MATCH (c)-[:HAS_SOURCE]->(remaining:Source)
    WITH c, collect(remaining.category) AS categories
    SET c.isKnown  = "known"  IN categories,
        c.isToKnow = "toKnow" IN categories,
        c.inMyBase = size(categories) > 0
  `,

  CRM_LIST_SOURCES: `
    MATCH (s:Source)
    WHERE s.name <> $legacySource
    RETURN s.name AS name, s.category AS category
    ORDER BY toLower(s.name)
  `,

  CRM_LIST_COMPANIES: `
    MATCH (c:CUIT)
    WHERE c.crmCompany = true
    RETURN c.id AS taxId,
           c.businessName AS businessName,
           c.crmBrand AS crmBrand,
           c.crmProduct AS crmProduct,
           c.crmOrigin AS crmOrigin,
           c.crmOriginSource AS originSource,
           coalesce(c.nosisPending, false) AND EXISTS { MATCH (c)-[:HAS_SOURCE]->(:Source {category: "known"}) } AS nosisPending,
           c.crmAddedAt AS addedAt,
           c.crmAddedBy AS addedBy,
           c.crmClosedAt AS closedAt,
           c.crmClosedReason AS closedReason,
           c.crmClosedBy AS closedBy,
           head(COLLECT {
             MATCH (c)<-[:ABOUT]-(a:Action) WHERE a.archivedAt IS NULL
             RETURN a.date ORDER BY a.date DESC LIMIT 1
           }) AS lastActionDate,
           head(COLLECT {
             MATCH (c)<-[:ABOUT]-(t:Task {status: "open"}) WHERE t.archivedAt IS NULL
             RETURN t.dueDate ORDER BY t.dueDate LIMIT 1
           }) AS nextDueDate,
           COUNT { MATCH (c)<-[:ABOUT]-(t:Task {status: "open"}) WHERE t.archivedAt IS NULL } AS openTaskCount
    ORDER BY toLower(c.businessName)
  `,

  CRM_FIND_COMPANY: `
    MATCH (c:CUIT {id: $taxId})
    WHERE c.crmCompany = true
    RETURN c.id AS taxId,
           c.businessName AS businessName,
           c.crmBrand AS crmBrand,
           c.crmProduct AS crmProduct,
           c.crmOrigin AS crmOrigin,
           c.crmOriginSource AS originSource,
           coalesce(c.nosisPending, false) AND EXISTS { MATCH (c)-[:HAS_SOURCE]->(:Source {category: "known"}) } AS nosisPending,
           c.crmAddedAt AS addedAt,
           c.crmAddedBy AS addedBy,
           c.crmClosedAt AS closedAt,
           c.crmClosedReason AS closedReason,
           c.crmClosedBy AS closedBy,
           head(COLLECT {
             MATCH (c)<-[:ABOUT]-(a:Action) WHERE a.archivedAt IS NULL
             RETURN a.date ORDER BY a.date DESC LIMIT 1
           }) AS lastActionDate,
           head(COLLECT {
             MATCH (c)<-[:ABOUT]-(t:Task {status: "open"}) WHERE t.archivedAt IS NULL
             RETURN t.dueDate ORDER BY t.dueDate LIMIT 1
           }) AS nextDueDate,
           COUNT { MATCH (c)<-[:ABOUT]-(t:Task {status: "open"}) WHERE t.archivedAt IS NULL } AS openTaskCount
  `,

  CRM_COMPANIES_IN_CRM: `
    UNWIND $taxIds AS taxId
    MATCH (c:CUIT {id: taxId})
    WHERE c.crmCompany = true
    RETURN c.id AS taxId
  `,

  CRM_UPDATE_COMPANY: `
    MATCH (c:CUIT {id: $taxId})
    SET c.crmBrand = $crmBrand, c.crmProduct = $crmProduct, c.crmOrigin = $crmOrigin, c.crmOriginSource = $originSource,
        c.nosisPending = CASE WHEN $markNosisPending THEN true ELSE c.nosisPending END
  `,

  CRM_FIND_REMOVAL_FACTS: `
    MATCH (c:CUIT {id: $taxId})
    RETURN coalesce(c.crmCreated, false) AS createdByCrm,
           (EXISTS { MATCH (c)<-[:WORKS_AT|IS]-(:Contact) }
              OR EXISTS { MATCH (c)<-[:ABOUT]-(:Action) }
              OR EXISTS { MATCH (c)<-[:ABOUT]-(:Task) }) AS hasHistory,
           EXISTS { MATCH (c)-[link:HAS_SOURCE]->(:Source) WHERE link.viaCrm IS NULL } AS hasSource,
           EXISTS { MATCH (c)-[:RELATED_TO]-(:CUIT {inMyBase: true}) } AS relatedToBase,
           COLLECT { MATCH (c)<-[:ABOUT]-(t:Task {status: "open"}) WHERE t.archivedAt IS NULL RETURN t.id } AS openTaskIds
  `,

  CRM_DETACH_CRM_SOURCES: `
    MATCH (c:CUIT {id: $taxId})
    CALL (c) {
      MATCH (c)-[r:HAS_SOURCE {viaCrm: true}]->(s:Source)
      DELETE r
      RETURN collect(s.name) AS detached
    }
    SET c.sources = [x IN coalesce(c.sources, []) WHERE NOT x IN detached]
    WITH c
    OPTIONAL MATCH (c)-[:HAS_SOURCE]->(remaining:Source)
    WITH c, collect(remaining.category) AS categories
    SET c.isKnown  = "known"  IN categories,
        c.isToKnow = "toKnow" IN categories,
        c.inMyBase = size(categories) > 0
  `,

  CRM_COMPANY_FLAG_INDEX: `
    CREATE INDEX cuit_crm_company IF NOT EXISTS FOR (c:CUIT) ON (c.crmCompany)
  `,

  CRM_UNLINK_COMPANY: `
    MATCH (c:CUIT {id: $taxId})
    SET c.crmCompany = false,
        c.nosisPending = false,
        c.crmArchivedAt = CASE WHEN $archive THEN $at ELSE c.crmArchivedAt END
  `,

  CRM_DELETE_COMPANY: `
    MATCH (c:CUIT {id: $taxId})
    WHERE c.crmCreated = true
      AND NOT EXISTS { MATCH (c)-[:HAS_SOURCE]->(:Source) }
      AND NOT EXISTS { MATCH (c)<-[:WORKS_AT|IS]-(:Contact) }
      AND NOT EXISTS { MATCH (c)<-[:ABOUT]-(:Action) }
      AND NOT EXISTS { MATCH (c)<-[:ABOUT]-(:Task) }
    DETACH DELETE c
  `,

  CRM_CLOSE_COMPANY: `
    MATCH (c:CUIT {id: $taxId})
    SET c.crmClosedAt = $at, c.crmClosedReason = $reason, c.crmClosedBy = $by
    WITH c
    OPTIONAL MATCH (level:TrustLevel)
    WHERE toLower(trim(level.label)) = $inservibleLabel
    WITH c, level, EXISTS { MATCH (c)-[:HAS_SOURCE]->(:Source) } AS inBase
    WITH c, level, inBase AND level IS NOT NULL AS inservible
    FOREACH (_ IN CASE WHEN inservible THEN [1] ELSE [] END |
      SET c.crmLevelBeforeClose = c.levelOfTrust,
          c.crmTrustReasonBeforeClose = c.trustReason,
          c.crmClosedLevel = level.value,
          c.levelOfTrust = level.value,
          c.trustReason = $reason
    )
    RETURN inservible
  `,

  CRM_REOPEN_COMPANY: `
    MATCH (c:CUIT {id: $taxId})
    FOREACH (_ IN CASE WHEN c.crmClosedLevel IS NOT NULL AND c.levelOfTrust = c.crmClosedLevel THEN [1] ELSE [] END |
      SET c.levelOfTrust = c.crmLevelBeforeClose, c.trustReason = c.crmTrustReasonBeforeClose
    )
    REMOVE c.crmClosedAt, c.crmClosedReason, c.crmClosedBy, c.crmClosedLevel, c.crmLevelBeforeClose, c.crmTrustReasonBeforeClose
  `,

  CRM_FIND_SOURCE: `
    MATCH (s:Source {name: $sourceName})
    WHERE s.name <> $legacySource
    RETURN s.name AS name, s.category AS category
  `,

  CRM_LOCK_OPEN_COMPANY: `
    MATCH (c:CUIT {id: $taxId})
    SET c.crmTouchedAt = $at
    RETURN c.crmClosedAt IS NULL AS open
  `,
} as const
