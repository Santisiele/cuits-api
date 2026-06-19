/**
 * Centralised Cypher query strings.
 *
 * Keeping queries here (rather than inlined in repository methods) makes them
 * easy to review, test, and optimise independently of application logic.
 * Dynamic depth parameters use template literals at call sites.
 */
export const Queries = {
  // ─── Node ──────────────────────────────────────────────────────────────────

  /** Find a single node by Tax ID. */
  FIND_NODE: `
    MATCH (c:CUIT {id: $taxId})
    RETURN c
  `,

  /** Update editable fields on a node. */
  UPDATE_NODE: `
    MATCH (c:CUIT {id: $taxId})
    SET c.phone    = $phone,
        c.email    = $email,
        c.birthday = $birthday
    RETURN c
  `,

  /** Find all inMyBase nodes with their relationship counts. */
  FIND_MY_BASE_NODES: `
    MATCH (c:CUIT {inMyBase: true})
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT)
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.sources       AS sources,
           count(DISTINCT related) AS relationshipCount
    ORDER BY c.businessName
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

  /** Delete a specific relationship between two nodes.
   *  After deletion, orphaned nodes that are not inMyBase are also removed.
   */
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

  // ─── Ingestion (used by the LoaderService) ─────────────────────────────────

  /**
   * Upsert an enrichment node (e.g. coming from Nosis tree traversal).
   * Does NOT mark the node as inMyBase and does NOT touch sources.
   * Preserves any existing businessName.
   */
  MERGE_ENRICHMENT_NODE: `
    MERGE (c:CUIT {id: $taxId})
    ON CREATE SET c.businessName = $businessName, c.inMyBase = false
    ON MATCH  SET c.businessName = COALESCE(c.businessName, $businessName)
  `,

  /**
   * Upsert a base node marking it as inMyBase, appending the source to
   * the sources array idempotently and writing whichever optional
   * attributes the caller provided (nulls are ignored at app level).
   *
   * The COALESCE pattern ensures: "if the parameter is null, keep the
   * existing value", giving callers fine-grained control over which
   * attributes a particular run overwrites.
   */
  MERGE_BASE_NODE: `
    MERGE (c:CUIT {id: $id})
    SET c.businessName = $name,
        c.inMyBase     = true,
        c.phone        = COALESCE($phone,     c.phone),
        c.email        = COALESCE($email,     c.email),
        c.entryDate    = COALESCE($entryDate, c.entryDate),
        c.exitDate     = COALESCE($exitDate,  c.exitDate),
        c.loadedAt     = COALESCE($loadedAt,  c.loadedAt),
        c.sources      = CASE
          WHEN c.sources IS NULL THEN [$source]
          WHEN $source IN c.sources THEN c.sources
          ELSE c.sources + $source
        END
  `,

  /** Idempotently creates a typed relationship between two nodes. */
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