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
           c.source        AS source,
           count(DISTINCT related) AS relationshipCount
    ORDER BY c.businessName
  `,

  // ─── Path ──────────────────────────────────────────────────────────────────

  /**
   * Find all paths from a node to inMyBase nodes up to a given depth.
   * Inject maxDepth as a template literal before running.
   */
  FIND_PATHS_TO_BASE: (maxDepth: number) => `
    MATCH path = (c:CUIT {id: $taxId})-[:RELATED_TO*1..${maxDepth}]-(target:CUIT {inMyBase: true})
    RETURN path
    LIMIT 10
  `,

  /**
   * Find the shortest path between two nodes.
   * Inject maxDepth as a template literal before running.
   */
  FIND_SHORTEST_PATH: (maxDepth: number) => `
    MATCH path = shortestPath(
      (a:CUIT {id: $fromTaxId})-[:RELATED_TO*1..${maxDepth}]-(b:CUIT {id: $toTaxId})
    )
    RETURN [node IN nodes(path) | node] AS pathNodes
  `,

  /** Find all relationships between two specific nodes. */
  FIND_RELATIONSHIPS_BETWEEN: `
    MATCH (a:CUIT {id: $fromId})-[r:RELATED_TO]-(b:CUIT {id: $toId})
    RETURN r.type AS type
  `,

  /**
   * Find all nodes reachable from a given node up to a given depth.
   * Inject maxDepth as a template literal before running.
   */
  FIND_ALL_RELATIONSHIPS: (maxDepth: number) => `
    MATCH path = (c:CUIT {id: $taxId})-[:RELATED_TO*1..${maxDepth}]-(connected:CUIT)
    RETURN path
  `,

  // ─── Relationship ──────────────────────────────────────────────────────────

  /** Check whether both nodes exist. */
  CHECK_NODES_EXIST: `
    MATCH (a:CUIT {id: $fromTaxId})
    MATCH (b:CUIT {id: $toTaxId})
    RETURN a, b
  `,

  /** Check whether a specific relationship already exists. */
  CHECK_RELATIONSHIP_EXISTS: `
    MATCH (a:CUIT {id: $fromTaxId})-[r:RELATED_TO {type: $relationshipType}]->(b:CUIT {id: $toTaxId})
    RETURN r
  `,

  /** Create a manual relationship between two nodes. */
  CREATE_RELATIONSHIP: `
    MATCH (a:CUIT {id: $fromTaxId})
    MATCH (b:CUIT {id: $toTaxId})
    CREATE (a)-[:RELATED_TO {type: $relationshipType, source: "manual", createdAt: datetime()}]->(b)
  `,

  /** Delete a specific relationship between two nodes. */
  DELETE_RELATIONSHIP: `
    MATCH (a:CUIT {id: $fromTaxId})-[r:RELATED_TO {type: $relationshipType}]->(b:CUIT {id: $toTaxId})
    DELETE r
    RETURN count(r) AS deleted
  `,

  // ─── Scripts (used by loadCuits / loadFromXlsx) ───────────────────────────

  /** Upsert a node without overwriting an existing businessName. */
  MERGE_NODE: `
    MERGE (c:CUIT {id: $taxId})
    ON CREATE SET c.businessName = $businessName, c.inMyBase = false
    ON MATCH  SET c.businessName = COALESCE(c.businessName, $businessName)
  `,

  /** Upsert a node marking it as inMyBase. */
  MERGE_BASE_NODE: `
    MERGE (c:CUIT {id: $id})
    SET c.businessName = $name,
        c.inMyBase     = true,
        c.source       = $source
  `,

  /** Upsert a relationship between two nodes. */
  MERGE_RELATIONSHIP: `
    MATCH (a:CUIT {id: $fromTaxId})
    MATCH (b:CUIT {id: $toTaxId})
    MERGE (a)-[r:RELATED_TO {type: $relationshipType}]->(b)
  `,
} as const