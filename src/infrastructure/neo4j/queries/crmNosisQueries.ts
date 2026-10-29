/** The queue of CRM CUITs waiting for a Nosis search. */
export const CrmNosisQueries = {
  CRM_NOSIS_PENDING_INDEX: `
    CREATE INDEX cuit_nosis_pending IF NOT EXISTS FOR (c:CUIT) ON (c.nosisPending)
  `,

  CRM_LIST_NOSIS_PENDING: `
    MATCH (c:CUIT)
    WHERE c.nosisPending = true AND EXISTS { MATCH (c)-[:HAS_SOURCE]->(:Source {category: "known"}) }
    RETURN c.id AS taxId, c.businessName AS businessName, coalesce(c.sources, []) AS sources,
           c.crmAddedBy AS addedBy, c.crmAddedAt AS addedAt
    ORDER BY c.crmAddedAt, c.id
  `,

  CRM_MARK_NOSIS_SEARCHED: `
    MATCH (c:CUIT {id: $taxId})
    SET c.nosisPending = false,
        c.nosisSearchedAt = $at,
        c.businessName = CASE WHEN coalesce(c.businessName, "") = "" THEN $businessName ELSE c.businessName END
  `,

  CRM_FIND_PENDING_MAIL: `
    MATCH (m:NosisPendingMail {id: "daily"})
    RETURN m.lastSentDay AS lastSentDay
  `,

  CRM_RECORD_PENDING_MAIL: `
    MERGE (m:NosisPendingMail {id: "daily"})
    SET m.lastSentDay = $day, m.lastSentAt = $at
  `,
} as const
