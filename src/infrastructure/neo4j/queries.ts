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
 *     group. FIND_TO_KNOW_NODES mirrors the same shape but filters by
 *     isToKnow=true, powering the "Objetivos" view.
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

  /**
   * Lists all "por conocer" nodes — the ones flagged as isToKnow=true.
   * Nodes that are also isKnown appear in this view too (a node can belong
   * to both groups simultaneously, and the objetivos view is inclusive).
   */
  FIND_TO_KNOW_NODES: `
    MATCH (c:CUIT {isToKnow: true})
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT)
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.sources       AS sources,
           c.isKnown       AS isKnown,
           c.isToKnow      AS isToKnow,
           count(DISTINCT related) AS relationshipCount
    ORDER BY c.businessName
  `,

  FIND_ALL_MY_NODES: `
    MATCH (c:CUIT {inMyBase: true})
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT)
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.sources       AS sources,
           c.isKnown       AS isKnown,
           c.isToKnow      AS isToKnow,
           count(DISTINCT related) AS relationshipCount
    ORDER BY c.businessName`,

  /**
   * Free-text search over business names across the whole graph.
   *
   * Deliberately not restricted to inMyBase: someone searching by name is
   * usually looking for a company they have not loaded yet, and those live
   * outside the base. `inMyBase` comes back so the caller can label them.
   *
   * A CONTAINS scan is a full label scan. At the current graph size that is
   * cheap, and the LIMIT bounds the payload; if the graph grows enough for
   * this to hurt, the fix is a full-text index on businessName.
   */
  SEARCH_NODES_BY_NAME: `
    MATCH (c:CUIT)
    WHERE c.businessName IS NOT NULL
      AND toLower(c.businessName) CONTAINS toLower($query)
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT)
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.sources       AS sources,
           c.inMyBase      AS inMyBase,
           count(DISTINCT related) AS relationshipCount
    ORDER BY c.businessName
    LIMIT $limit
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
   *
   * Source semantics: the (:Source) node is the source of truth, while
   * `c.sources` is a denormalised read cache. Both are written in this
   * single statement so they can never drift apart. `$sourceCategory` is
   * applied ON CREATE only — the first loader to touch a source name
   * decides its category, and later loaders never overwrite it (changing
   * it is an admin operation, not an ingestion side effect).
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
    WITH c
    MERGE (s:Source {name: $source})
    ON CREATE SET s.category = $sourceCategory
    MERGE (c)-[:HAS_SOURCE]->(s)
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

  // ─── Sources ───────────────────────────────────────────────────────────────

  /**
   * Lists every Source node with its category and the count of CUITs
   * currently attached. Used by the admin UI (fase 2) and available
   * for internal reporting.
   */
  FIND_SOURCES: `
    MATCH (s:Source)
    OPTIONAL MATCH (c:CUIT)-[:HAS_SOURCE]->(s)
    RETURN s.name       AS name,
           s.category   AS category,
           count(c)     AS nodeCount
    ORDER BY s.name
  `,

  /**
   * Guarantees one (:Source) per name. Idempotent, so the migration script
   * can run it on every pass; it also backs name lookups with an index.
   */
  CREATE_SOURCE_CONSTRAINT: `
    CREATE CONSTRAINT source_name_unique IF NOT EXISTS
    FOR (s:Source) REQUIRE s.name IS UNIQUE
  `,

  // ─── Source admin — shared ─────────────────────────────────────────────────

  /**
   * Number of CUITs currently attached to a source. Measured before an
   * operation runs so a dry run and the real execution report the same
   * figure.
   */
  COUNT_CUITS_FOR_SOURCE: `
    MATCH (c:CUIT)-[:HAS_SOURCE]->(:Source {name: $sourceName})
    RETURN count(c) AS affectedNodeCount
  `,

  /** Existence check used before delete, which has no other precondition. */
  CHECK_SOURCE_EXISTS: `
    OPTIONAL MATCH (s:Source {name: $sourceName})
    RETURN s IS NOT NULL AS sourceExists
  `,

  /**
   * Ids of every CUIT attached to a source.
   *
   * Captured BEFORE a delete detaches them, because afterwards there is no
   * way to tell which orphans the operation produced and which were already
   * in the graph. The orphan sweep is then restricted to these ids.
   */
  FIND_CUIT_IDS_FOR_SOURCE: `
    MATCH (c:CUIT)-[:HAS_SOURCE]->(:Source {name: $sourceName})
    RETURN c.id AS id
  `,

  // ─── Source admin — rename ─────────────────────────────────────────────────

  /**
   * Checks that the source exists and the target name is free.
   * A taken name would mean an implicit merge, which rename refuses.
   */
  CHECK_RENAME_ELIGIBILITY: `
    OPTIONAL MATCH (existing:Source {name: $oldName})
    OPTIONAL MATCH (conflict:Source {name: $newName})
    RETURN existing IS NOT NULL AS sourceExists,
           conflict IS NOT NULL AS newNameExists
  `,

  /**
   * Renames the source node itself. O(1): the relationships already point
   * at this node, so only the cached arrays need a follow-up pass.
   */
  RENAME_SOURCE_NODE: `
    MATCH (s:Source {name: $oldName})
    SET s.name = $newName
    RETURN s.category AS category
  `,

  /**
   * Rewrites the cached `sources` array on CUITs still holding the old name.
   *
   * Self-terminating: every pass strips `$oldName` from the batch it touches,
   * so those rows stop matching the WHERE and the next pass moves on. Runs
   * after RENAME_SOURCE_NODE, hence matching on the NEW name.
   */
  UPDATE_SOURCES_ARRAY_FOR_RENAME_BATCH: `
    MATCH (c:CUIT)-[:HAS_SOURCE]->(:Source {name: $newName})
    WHERE $oldName IN c.sources
    WITH c LIMIT $batchSize
    SET c.sources = [x IN c.sources WHERE x <> $oldName] + $newName
    RETURN count(c) AS batchProcessed
  `,

  // ─── Source admin — merge ──────────────────────────────────────────────────

  /**
   * Both sources must exist and share a category: merging across categories
   * would silently reclassify every node involved.
   */
  CHECK_MERGE_ELIGIBILITY: `
    OPTIONAL MATCH (keep:Source {name: $sourceToKeep})
    OPTIONAL MATCH (drop:Source {name: $sourceToDrop})
    RETURN keep IS NOT NULL AS keepExists,
           drop IS NOT NULL AS dropExists,
           keep.category    AS keepCategory,
           drop.category    AS dropCategory
  `,

  /**
   * Moves up to $batchSize CUITs from the dropped source onto the kept one
   * and rewrites their cached array in the same statement.
   *
   * Flags are left alone on purpose: both sources share a category, so the
   * node's known/toKnow standing cannot change.
   */
  MERGE_SOURCE_RELATIONSHIPS_BATCH: `
    MATCH (c:CUIT)-[oldRel:HAS_SOURCE]->(:Source {name: $sourceToDrop})
    WITH c, oldRel LIMIT $batchSize
    MATCH (keep:Source {name: $sourceToKeep})
    MERGE (c)-[:HAS_SOURCE]->(keep)
    DELETE oldRel
    SET c.sources = [x IN c.sources WHERE x <> $sourceToDrop AND x <> $sourceToKeep] + $sourceToKeep
    RETURN count(c) AS batchProcessed
  `,

  /**
   * Drops the merged-away source. The emptiness guard is a safety net: if a
   * batch failed silently, the node survives with its remaining CUITs rather
   * than taking them down with it.
   */
  DELETE_SOURCE_NODE_AFTER_MERGE: `
    MATCH (s:Source {name: $sourceToDrop})
    WHERE NOT EXISTS { MATCH (:CUIT)-[:HAS_SOURCE]->(s) }
    DETACH DELETE s
  `,

  // ─── Source admin — delete ─────────────────────────────────────────────────

  /**
   * Dry-run estimate of how many CUITs the delete would leave orphaned:
   * attached to this source, to no other source, and to no node that is
   * itself in the base.
   */
  COUNT_ORPHANS_FOR_SOURCE: `
    MATCH (c:CUIT)-[:HAS_SOURCE]->(:Source {name: $sourceName})
    WHERE NOT EXISTS {
            MATCH (c)-[:HAS_SOURCE]->(other:Source)
            WHERE other.name <> $sourceName
          }
      AND NOT EXISTS { MATCH (c)-[:RELATED_TO]-(:CUIT {inMyBase: true}) }
    RETURN count(c) AS orphanCount
  `,

  /**
   * Detaches up to $batchSize CUITs from the source and recalculates their
   * flags from whatever sources remain.
   *
   * `collect` drops nulls, so a node left with no source yields an empty
   * list and lands on isKnown=false / isToKnow=false / inMyBase=false.
   * Deleting the (:Source) and the orphaned CUITs are separate passes.
   */
  DELETE_SOURCE_RELATIONSHIPS_BATCH: `
    MATCH (c:CUIT)-[r:HAS_SOURCE]->(:Source {name: $sourceName})
    WITH c, r LIMIT $batchSize
    DELETE r
    WITH c
    SET c.sources = [x IN c.sources WHERE x <> $sourceName]
    WITH c
    OPTIONAL MATCH (c)-[:HAS_SOURCE]->(remaining:Source)
    WITH c, collect(remaining.category) AS remainingCategories
    SET c.isKnown  = "known"  IN remainingCategories,
        c.isToKnow = "toKnow" IN remainingCategories,
        c.inMyBase = size(remainingCategories) > 0
    RETURN count(c) AS batchProcessed
  `,

  /** Removes the source node once every attachment is gone. */
  DELETE_SOURCE_NODE: `
    MATCH (s:Source {name: $sourceName})
    DETACH DELETE s
  `,

  /**
   * Deletes the CUITs from $ids that the operation left orphaned: no source
   * left, not in the base, and not hanging off anyone who is.
   *
   * Scoped to $ids rather than sweeping the whole graph, so an unrelated
   * enrichment node that merely looks orphaned is never collateral damage.
   * The count is taken before the delete, since a deleted node can no longer
   * be projected.
   */
  DELETE_ORPHANED_NODES_BATCH: `
    UNWIND $ids AS cuitId
    MATCH (c:CUIT {id: cuitId})
    WHERE c.inMyBase = false
      AND NOT EXISTS { MATCH (c)-[:HAS_SOURCE]->(:Source) }
      AND NOT EXISTS { MATCH (c)-[:RELATED_TO]-(:CUIT {inMyBase: true}) }
    WITH collect(c) AS orphans
    FOREACH (orphan IN orphans | DETACH DELETE orphan)
    RETURN size(orphans) AS removedCount
  `,

  // ─── Source admin — node level ─────────────────────────────────────────────

  /** Node and target source must both exist before an add. */
  CHECK_ADD_ELIGIBILITY: `
    OPTIONAL MATCH (c:CUIT {id: $taxId})
    OPTIONAL MATCH (s:Source {name: $sourceName})
    RETURN c IS NOT NULL AS nodeExists,
           s IS NOT NULL AS sourceExists
  `,

  /**
   * Attaches a source to one CUIT. Idempotent - re-running changes nothing.
   *
   * COALESCE guards nodes created by MERGE_ENRICHMENT_NODE, which carry no
   * `sources` property at all; without it the array arithmetic yields null
   * and wipes the cache.
   */
  ADD_SOURCE_TO_NODE: `
    MATCH (c:CUIT {id: $taxId})
    MATCH (s:Source {name: $sourceName})
    MERGE (c)-[:HAS_SOURCE]->(s)
    SET c.sources = CASE
      WHEN $sourceName IN COALESCE(c.sources, []) THEN c.sources
      ELSE COALESCE(c.sources, []) + $sourceName
    END
    WITH c
    MATCH (c)-[:HAS_SOURCE]->(remaining:Source)
    WITH c, collect(remaining.category) AS categories
    SET c.isKnown  = "known"  IN categories,
        c.isToKnow = "toKnow" IN categories,
        c.inMyBase = size(categories) > 0
    RETURN c.id AS taxId
  `,

  /**
   * Node must exist, must currently carry `fromSource`, and `toSource` must
   * exist. `fromExists` conflates "no such source" with "not attached to it"
   * because the caller treats both the same way.
   */
  CHECK_MOVE_ELIGIBILITY: `
    OPTIONAL MATCH (c:CUIT {id: $taxId})
    OPTIONAL MATCH (c)-[:HAS_SOURCE]->(from:Source {name: $fromSource})
    OPTIONAL MATCH (to:Source {name: $toSource})
    RETURN c IS NOT NULL    AS nodeExists,
           from IS NOT NULL AS fromExists,
           to IS NOT NULL   AS toExists
  `,

  /**
   * Detaches one source and attaches another in a single statement, then
   * recalculates flags. A move always leaves at least `toSource` attached,
   * so it can never orphan the node.
   */
  MOVE_SOURCE_ON_NODE: `
    MATCH (c:CUIT {id: $taxId})-[r:HAS_SOURCE]->(:Source {name: $fromSource})
    MATCH (to:Source {name: $toSource})
    DELETE r
    MERGE (c)-[:HAS_SOURCE]->(to)
    SET c.sources = [x IN COALESCE(c.sources, []) WHERE x <> $fromSource AND x <> $toSource] + $toSource
    WITH c
    MATCH (c)-[:HAS_SOURCE]->(remaining:Source)
    WITH c, collect(remaining.category) AS categories
    SET c.isKnown  = "known"  IN categories,
        c.isToKnow = "toKnow" IN categories,
        c.inMyBase = size(categories) > 0
    RETURN c.id AS taxId
  `,
} as const