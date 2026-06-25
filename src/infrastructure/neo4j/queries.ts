/**
 * Centralised Cypher query strings.
 */
export const Queries = {
  // ─── Node ──────────────────────────────────────────────────────────────────

  FIND_NODE: `
    MATCH (c:CUIT {id: $taxId})
    RETURN c
  `,

  UPDATE_NODE: `
    MATCH (c:CUIT {id: $taxId})
    SET c.phone    = $phone,
        c.email    = $email,
        c.birthday = $birthday
    RETURN c
  `,

  FIND_MY_BASE_NODES: `
    MATCH (c:CUIT {inMyBase: true})
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT)
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.sources       AS sources,
           count(DISTINCT related) AS relationshipCount
    ORDER BY c.businessName
  `,

  /**
   * Returns every inMyBase node that has a non-empty `birthday` field.
   * Date-range filtering happens in the application layer, since
   * `birthday` is stored as a dd/mm/yyyy string — comparing it in Cypher
   * would require expensive string parsing per row.
   */
  FIND_BIRTHDAY_CANDIDATES: `
    MATCH (c:CUIT {inMyBase: true})
    WHERE c.birthday IS NOT NULL AND c.birthday <> ""
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT)
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.birthday      AS birthday,
           c.sources       AS sources,
           count(DISTINCT related) AS relationshipCount
  `,

  // ─── Path ──────────────────────────────────────────────────────────────────

  FIND_PATHS_TO_BASE: (maxDepth: number) => `
    MATCH path = (c:CUIT {id: $taxId})-[:RELATED_TO*1..${maxDepth}]-(target:CUIT {inMyBase: true})
    RETURN path
    LIMIT 10
  `,

  FIND_SHORTEST_PATH: (maxDepth: number) => `
    MATCH path = shortestPath(
      (a:CUIT {id: $fromTaxId})-[:RELATED_TO*1..${maxDepth}]-(b:CUIT {id: $toTaxId})
    )
    RETURN [node IN nodes(path) | node] AS pathNodes
  `,

  FIND_RELATIONSHIPS_BETWEEN: `
    MATCH (a:CUIT {id: $fromId})-[r:RELATED_TO]-(b:CUIT {id: $toId})
    RETURN r.type AS type
  `,

  FIND_ALL_RELATIONSHIPS: (maxDepth: number) => `
    MATCH path = (c:CUIT {id: $taxId})-[:RELATED_TO*1..${maxDepth}]-(connected:CUIT)
    RETURN path
  `,

  // ─── Relationship ──────────────────────────────────────────────────────────

  CHECK_NODES_EXIST: `
    MATCH (a:CUIT {id: $fromTaxId})
    MATCH (b:CUIT {id: $toTaxId})
    RETURN a, b
  `,

  CHECK_RELATIONSHIP_EXISTS: `
    MATCH (a:CUIT {id: $fromTaxId})-[r:RELATED_TO {type: $relationshipType}]->(b:CUIT {id: $toTaxId})
    RETURN r
  `,

  CREATE_RELATIONSHIP: `
    MATCH (a:CUIT {id: $fromTaxId})
    MATCH (b:CUIT {id: $toTaxId})
    CREATE (a)-[:RELATED_TO {type: $relationshipType, source: "manual", createdAt: datetime()}]->(b)
  `,

  DELETE_RELATIONSHIP: `
    MATCH (a:CUIT {id: $fromTaxId})-[r:RELATED_TO {type: $relationshipType}]->(b:CUIT {id: $toTaxId})
    DELETE r
    WITH a, b
    FOREACH (_ IN CASE
      WHEN NOT (a)-[:RELATED_TO]-() AND (a.inMyBase IS NULL OR a.inMyBase = false)
      THEN [1] ELSE [] END |
      DETACH DELETE a
    )
    FOREACH (_ IN CASE
      WHEN NOT (b)-[:RELATED_TO]-() AND (b.inMyBase IS NULL OR b.inMyBase = false)
      THEN [1] ELSE [] END |
      DETACH DELETE b
    )
    RETURN 1 AS deleted
  `,

  // ─── Ingestion ─────────────────────────────────────────────────────────────

  MERGE_ENRICHMENT_NODE: `
    MERGE (c:CUIT {id: $taxId})
    ON CREATE SET c.businessName = $businessName, c.inMyBase = false
    ON MATCH  SET c.businessName = COALESCE(c.businessName, $businessName)
  `,

  MERGE_BASE_NODE: `
    MERGE (c:CUIT {id: $id})
    SET c.businessName = $name,
        c.inMyBase     = true,
        c.phone        = COALESCE($phone,     c.phone),
        c.email        = COALESCE($email,     c.email),
        c.birthday     = COALESCE($birthday,  c.birthday),
        c.entryDate    = COALESCE($entryDate, c.entryDate),
        c.exitDate     = COALESCE($exitDate,  c.exitDate),
        c.loadedAt     = COALESCE($loadedAt,  c.loadedAt),
        c.sources      = CASE
          WHEN c.sources IS NULL THEN [$source]
          WHEN $source IN c.sources THEN c.sources
          ELSE c.sources + $source
        END
  `,

  MERGE_RELATIONSHIP: `
    MATCH (a:CUIT {id: $fromTaxId})
    MATCH (b:CUIT {id: $toTaxId})
    MERGE (a)-[r:RELATED_TO {type: $relationshipType}]->(b)
  `,

  // ─── Companies ─────────────────────────────────────────────────────────────

  FIND_COMPANIES: `
    MATCH (c:CUIT)
    WHERE (c.id STARTS WITH '30' OR c.id STARTS WITH '33')
      AND (c.inMyBase IS NULL OR c.inMyBase = false)
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT {inMyBase: true})
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.sources       AS sources,
           count(DISTINCT related) AS relationshipCount
    ORDER BY relationshipCount DESC
  `,
} as const