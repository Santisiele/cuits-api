/**
 * Centralised Cypher query strings.
 *
 * Classification flags (`isKnown`, `isToKnow`) introduced for the
 * "conocidos / por conocer" split:
 *   - MERGE_BASE_NODE accepts both flags and merges them additively
 *     (a node already isKnown stays isKnown even when re-loaded as isToKnow)
 *   - inMyBase is kept on the node as a derived field (isKnown OR isToKnow)
 *     for backward compatibility
 *   - The standard list queries filter by isKnown=true so the existing
 *     "Mi base / Empresas / Cumpleaños" views show only the "conocidos"
 *     group, as agreed
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

  /**
   * Lists all "conocidos" nodes.
   * Filters by isKnown=true so a node that's exclusively isToKnow is hidden
   * from this view (the "Mi base" tab is the conocidos view, per the spec).
   */
  FIND_MY_BASE_NODES: `
    MATCH (c:CUIT {isKnown: true})
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT)
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.sources       AS sources,
           c.isKnown       AS isKnown,
           c.isToKnow      AS isToKnow,
           count(DISTINCT related) AS relationshipCount
    ORDER BY c.businessName
  `,

  FIND_BIRTHDAY_CANDIDATES: `
    MATCH (c:CUIT {isKnown: true})
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

  /**
   * Upserts a base-group node.
   *
   * Classification semantics:
   *   - `$isKnown`  → if true, the node's isKnown flag is set to true.
   *                   If false/null, the existing value is preserved (additive).
   *   - `$isToKnow` → same logic for isToKnow.
   *
   * This lets a node already loaded as "conocido" stay as such when a new
   * "por conocer" loader re-encounters it, AND vice versa. The end state
   * is the union of all loader passes.
   *
   * `inMyBase` is derived (isKnown OR isToKnow) and updated in the same
   * statement, so the legacy field stays accurate.
   */
  MERGE_BASE_NODE: `
    MERGE (c:CUIT {id: $id})
    SET c.businessName = $name,
        c.isKnown      = CASE WHEN $isKnown = true THEN true ELSE COALESCE(c.isKnown, false) END,
        c.isToKnow     = CASE WHEN $isToKnow = true THEN true ELSE COALESCE(c.isToKnow, false) END,
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
        END,
        c += $customFields
    WITH c
    SET c.inMyBase = (c.isKnown = true OR c.isToKnow = true)
  `,

  MERGE_RELATIONSHIP: `
    MATCH (a:CUIT {id: $fromTaxId})
    MATCH (b:CUIT {id: $toTaxId})
    MERGE (a)-[r:RELATED_TO {type: $relationshipType}]->(b)
  `,

  // ─── Companies ─────────────────────────────────────────────────────────────

  /**
   * Lists CUITs starting with 30/33 that are NOT in our "conocidos" group,
   * along with how many "conocidos" nodes they're directly related to.
   *
   * Filtering by `NOT isKnown` (not just `NOT inMyBase`) means companies that
   * are exclusively "por conocer" still show up here. That matches the spec:
   * we're showing "companies the user might want to know about"; a "por
   * conocer" entry counts as a wish-list item, not a conocida.
   *
   * Companies that are isKnown=true (real conocidas) are excluded.
   */
  FIND_COMPANIES: `
    MATCH (c:CUIT)
    WHERE (c.id STARTS WITH '30' OR c.id STARTS WITH '33')
      AND (c.isKnown IS NULL OR c.isKnown = false)
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT {isKnown: true})
    WITH c, related
    UNWIND CASE WHEN related.sources IS NULL THEN [null] ELSE related.sources END AS srcRaw
    WITH c,
         count(DISTINCT related) AS relationshipCount,
         collect(DISTINCT srcRaw) AS rawSources
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.sources       AS sources,
           c.isKnown       AS isKnown,
           c.isToKnow      AS isToKnow,
           relationshipCount,
           [s IN rawSources WHERE s IS NOT NULL] AS relatedSources
    ORDER BY relationshipCount DESC
  `,
} as const