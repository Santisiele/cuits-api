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

  /**
   * Updates the editable fields of a node.
   *
   * The first three are assigned straight from their parameter, so omitting
   * one clears it. That suits the edit form, which always submits every field
   * it shows.
   *
   * `levelOfTrust` is COALESCEd instead, because it is not on that form: a
   * caller sending only a phone number must not wipe a trust level it never
   * knew about. Sending 0 still clears it — 0 is this project's "no value".
   */
  FIND_NODE_OPERATIONS: `
    MATCH (c:CUIT {id: $taxId})
    RETURN c.bolsaOperations AS bolsaOperations, c.financieraOperations AS financieraOperations,
           c.bankOperations AS bankOperations
  `,

  UPDATE_NODE: `
    MATCH (c:CUIT {id: $taxId})
    SET c.phone        = $phone,
        c.email        = $email,
        c.birthday     = $birthday,
        c.levelOfTrust = COALESCE($levelOfTrust, c.levelOfTrust),
        c.trustReason  = COALESCE($trustReason, c.trustReason)
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
           c.levelOfTrust  AS levelOfTrust,
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
           c.levelOfTrust  AS levelOfTrust,
           count(DISTINCT related) AS relationshipCount
    ORDER BY c.businessName
  `,

  /**
   * The union of both groups, optionally narrowed to one source.
   *
   * `$source` is null when the caller wants everything. The filter reads the
   * cached `sources` array rather than walking [:HAS_SOURCE], to keep the same
   * semantics the callers had while they were filtering that array themselves.
   */
  FIND_ALL_MY_NODES: `
    MATCH (c:CUIT {inMyBase: true})
    WHERE $source IS NULL OR $source IN coalesce(c.sources, [])
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT)
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.sources       AS sources,
           c.isKnown       AS isKnown,
           c.isToKnow      AS isToKnow,
           c.levelOfTrust  AS levelOfTrust,
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
           c.levelOfTrust  AS levelOfTrust,
           count(DISTINCT related) AS relationshipCount,
           count(DISTINCT CASE WHEN related.isKnown = true THEN related END) AS knownRelationshipCount
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
           c.levelOfTrust  AS levelOfTrust,
           count(DISTINCT related) AS relationshipCount
  `,

  // ─── Path ──────────────────────────────────────────────────────────────────

  FIND_PATHS_TO_BASE: (maxDepth: number) => `
    MATCH path = (c:CUIT {id: $taxId})-[:RELATED_TO*1..${maxDepth}]-(target:CUIT {inMyBase: true})
    WHERE all(n IN nodes(path) WHERE single(m IN nodes(path) WHERE m = n))
    RETURN path
    ORDER BY length(path)
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
        AND NOT EXISTS { MATCH (a)<-[:WORKS_AT|IS]-(:Contact) }
        AND NOT EXISTS { MATCH (a)<-[:ABOUT]-(:Action) }
        AND NOT EXISTS { MATCH (a)<-[:ABOUT]-(:Task) }
      THEN [1] ELSE [] END |
      DETACH DELETE a
    )
    FOREACH (_ IN CASE
      WHEN NOT (b)-[:RELATED_TO]-() AND (b.inMyBase IS NULL OR b.inMyBase = false)
        AND NOT EXISTS { MATCH (b)<-[:WORKS_AT|IS]-(:Contact) }
        AND NOT EXISTS { MATCH (b)<-[:ABOUT]-(:Action) }
        AND NOT EXISTS { MATCH (b)<-[:ABOUT]-(:Task) }
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
    SET c.businessName = CASE WHEN $name IS NULL OR trim($name) = '' THEN COALESCE(c.businessName, '') ELSE $name END,
        c.isKnown      = CASE WHEN $isKnown = true THEN true ELSE COALESCE(c.isKnown, false) END,
        c.isToKnow     = CASE WHEN $isToKnow = true THEN true ELSE COALESCE(c.isToKnow, false) END,
        c.phone        = COALESCE($phone,     c.phone),
        c.email        = COALESCE($email,     c.email),
        c.birthday     = COALESCE($birthday,  c.birthday),
        c.entryDate    = COALESCE($entryDate, c.entryDate),
        c.exitDate     = COALESCE($exitDate,  c.exitDate),
        c.loadedAt     = COALESCE($loadedAt,  c.loadedAt),
        c.levelOfTrust = COALESCE($levelOfTrust,  c.levelOfTrust),
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
           c.levelOfTrust  AS levelOfTrust,
           relationshipCount,
           [s IN rawSources WHERE s IS NOT NULL] AS relatedSources
    ORDER BY relationshipCount DESC
  `,

  // ─── Crossing over ─────────────────────────────────────────────────────────

  /**
   * Nodes that belong to every source in `$sources` at once, where a company
   * may belong to a source through a neighbour instead of through its own
   * `sources` list.
   *
   * Two ways of belonging:
   *   - directly, the source is in the node's own `sources`
   *   - by relation, the node is a company (30/33) with a direct neighbour
   *     that has the source. Only companies qualify this way, because the
   *     point of the view is to find companies reachable through the people
   *     already loaded — "Residentes Senior Home" holds no company of its own,
   *     so crossing it against anything used to return nothing at all.
   *
   * At least one selected source has to be direct (`ANY`). Without that, a
   * company sitting between two unrelated sources but loaded from neither
   * would show up, which is a much weaker claim than the view makes.
   *
   * `indirectSources` names which of the selected sources the node only
   * reaches by relation, so the caller can mark those rows. An empty list
   * means the node is a plain member of all of them.
   *
   * `coalesce` guards the nodes discovered through enrichment: they carry no
   * `sources` property at all, and `x IN null` is null, not false.
   */
  FIND_CROSSING_NODES: `
    MATCH (c:CUIT)
    WHERE ANY(src IN $sources WHERE src IN coalesce(c.sources, []))
      AND ALL(src IN $sources WHERE
            src IN coalesce(c.sources, [])
            OR ((c.id STARTS WITH '30' OR c.id STARTS WITH '33')
                AND EXISTS {
                  MATCH (c)-[:RELATED_TO]-(p:CUIT)
                  WHERE src IN coalesce(p.sources, [])
                }))
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT)
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.sources       AS sources,
           c.isKnown       AS isKnown,
           c.isToKnow      AS isToKnow,
           c.levelOfTrust  AS levelOfTrust,
           count(DISTINCT related) AS relationshipCount,
           [src IN $sources WHERE NOT src IN coalesce(c.sources, [])] AS indirectSources
    ORDER BY c.businessName
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
      AND NOT EXISTS { MATCH (c)<-[:WORKS_AT|IS]-(:Contact) }
      AND NOT EXISTS { MATCH (c)<-[:ABOUT]-(:Action) }
      AND NOT EXISTS { MATCH (c)<-[:ABOUT]-(:Task) }
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
  FIND_TRUST_LEVELS: `
    MATCH (t:TrustLevel)
    OPTIONAL MATCH (c:CUIT {levelOfTrust: t.value})
    RETURN t.value AS value,
           t.label AS label,
           t.color AS color,
           count(c) AS nodeCount,
           t.description AS description
    ORDER BY t.value
  `,

  FIND_TRUST_LEVEL: `
    MATCH (t:TrustLevel {value: $value})
    RETURN t.value AS value, t.label AS label, t.color AS color, t.description AS description
  `,

  FIND_TRUST_LEVEL_BY_LABEL: `
    MATCH (t:TrustLevel)
    WHERE toLower(t.label) = toLower($label)
    RETURN t.value AS value
  `,

  NEXT_TRUST_LEVEL_VALUE: `
    MATCH (t:TrustLevel)
    RETURN coalesce(max(t.value), 0) + 1 AS value
  `,

  CREATE_TRUST_LEVEL: `
    CREATE (t:TrustLevel {value: $value, label: $label, color: $color, description: $description})
    RETURN t.value AS value
  `,

  UPDATE_TRUST_LEVEL: `
    MATCH (t:TrustLevel {value: $value})
    SET t.label = coalesce($label, t.label),
        t.color = coalesce($color, t.color),
        t.description = coalesce($description, t.description)
    RETURN t.label AS label
  `,

  EXPORT_NODES: `
    MATCH (n)
    RETURN elementId(n) AS key, labels(n) AS labels, properties(n) AS properties
  `,

  EXPORT_RELATIONSHIPS: `
    MATCH (a)-[r]->(b)
    RETURN elementId(a) AS from, elementId(b) AS to, type(r) AS type, properties(r) AS properties
  `,

  FIND_LAST_BACKUP: `
    MATCH (b:Backup {id: $id}) RETURN b.lastRunAt AS lastRunAt
  `,

  RECORD_BACKUP: `
    MERGE (b:Backup {id: $id})
    SET b.lastRunAt = $lastRunAt
  `,

  COUNT_ALL_NODES: `
    MATCH (n) RETURN count(n) AS total
  `,

  CREATE_RESTORE_INDEX: `
    CREATE INDEX backup_restore_key IF NOT EXISTS FOR (n:BackupRestore) ON (n.__backupKey)
  `,

  AWAIT_INDEXES: `
    CALL db.awaitIndexes(300)
  `,

  DROP_RESTORE_INDEX: `
    DROP INDEX backup_restore_key IF EXISTS
  `,

  CLEAR_BACKUP_KEYS: `
    MATCH (n:BackupRestore)
    WITH n LIMIT $batchSize
    REMOVE n.__backupKey, n:BackupRestore
    RETURN count(n) AS cleared
  `,

  TOUCH_KEEP_ALIVE: `
    MERGE (k:KeepAlive {id: $id})
    SET k.pingedAt = $pingedAt
  `,

  COUNT_PEOPLE_WITHOUT_BIRTHDAY: `
    MATCH (c:CUIT {isKnown: true})
    WHERE c.id =~ '^(20|23|24|27)[0-9]{9}$'
      AND (c.birthday IS NULL OR trim(c.birthday) = '')
    RETURN count(c) AS pending
  `,

  FIND_BIRTHDAY_CANDIDATES_FOR_SWEEP: `
    MATCH (c:CUIT {isKnown: true})
    WHERE c.id =~ '^(20|23|24|27)[0-9]{9}$'
      AND (c.birthday IS NULL OR trim(c.birthday) = '')
      AND NOT c.id IN $skip
    OPTIONAL MATCH (c)-[:HAS_SOURCE]->(s:Source)
    WITH c, collect(s.name) AS sources
    WITH c, sources,
         CASE
           WHEN 'Residentes Senior Home' IN sources THEN 0
           WHEN 'Responsables Senior Home' IN sources THEN 1
           ELSE 2
         END AS priority
    RETURN c.id AS taxId, c.businessName AS businessName, priority
    ORDER BY priority, taxId
    LIMIT $limit
  `,

  SAVE_BIRTHDAY_SWEEP: `
    MERGE (b:BirthdaySweep {id: "daily"})
    SET b.day = $day,
        b.consultedToday = $consultedToday,
        b.dailyLimit = $dailyLimit,
        b.misses = $misses,
        b.updatedAt = $updatedAt
  `,

  FIND_BIRTHDAY_SWEEP: `
    MATCH (b:BirthdaySweep {id: "daily"})
    RETURN b.day            AS day,
           b.consultedToday AS consultedToday,
           b.dailyLimit     AS dailyLimit,
           b.misses         AS misses,
           b.updatedAt      AS updatedAt
  `,

  COUNT_KNOWN_PEOPLE_BIRTHDAYS: `
    MATCH (c:CUIT {isKnown: true})
    WHERE c.id =~ '^(20|23|24|27)[0-9]{9}$'
    RETURN count(c) AS knownPeople,
           count(CASE WHEN c.birthday IS NOT NULL AND trim(c.birthday) <> '' THEN 1 END) AS withBirthday
  `,

  COUNT_BIRTHDAYS_BY_SOURCE: `
    MATCH (s:Source {category: "known"})
    OPTIONAL MATCH (s)<-[:HAS_SOURCE]-(c:CUIT {isKnown: true})
    WHERE c.id =~ '^(20|23|24|27)[0-9]{9}$'
    WITH s.name AS source,
         count(c) AS people,
         count(CASE WHEN c.birthday IS NOT NULL AND trim(c.birthday) <> '' THEN 1 END) AS withBirthday
    RETURN source, people, withBirthday, people - withBirthday AS missing
    ORDER BY missing DESC, source
  `,

  FIND_CUIT_NAMES: `
    UNWIND $taxIds AS taxId
    OPTIONAL MATCH (c:CUIT {id: taxId})
    RETURN taxId, coalesce(c.businessName, '') AS businessName
  `,

  FIND_PEOPLE_PENDING_BIRTHDAY: `
    MATCH (c:CUIT {isKnown: true})
    WHERE c.id =~ '^(20|23|24|27)[0-9]{9}$'
      AND (c.birthday IS NULL OR trim(c.birthday) = '')
      AND NOT c.id IN $skip
    OPTIONAL MATCH (c)-[:HAS_SOURCE]->(s:Source)
    WITH c, s.name AS source
    ORDER BY source
    WITH c, collect(source) AS sources
    RETURN c.id AS taxId, coalesce(c.businessName, '') AS businessName, sources
    ORDER BY businessName, taxId
  `,

  SET_BIRTHDAY: `
    MATCH (c:CUIT {id: $taxId})
    SET c.birthday = $birthday
    RETURN c.id AS taxId
  `,

  FIND_TRUST_LEVEL_MEMBERS: `
    MATCH (c:CUIT {levelOfTrust: $value})
    OPTIONAL MATCH (c)-[:RELATED_TO]-(related:CUIT)
    RETURN c.id            AS taxId,
           c.businessName  AS businessName,
           c.sources       AS sources,
           c.isKnown       AS isKnown,
           c.isToKnow      AS isToKnow,
           c.trustReason   AS trustReason,
           count(DISTINCT related) AS relationshipCount
    ORDER BY c.businessName
  `,

  COUNT_CUITS_FOR_TRUST_LEVEL: `
    MATCH (c:CUIT {levelOfTrust: $value})
    RETURN count(c) AS affectedNodeCount
  `,

  CLEAR_TRUST_LEVEL_FROM_NODES: `
    MATCH (c:CUIT {levelOfTrust: $value})
    WITH c LIMIT $batchSize
    SET c.levelOfTrust = 0
    RETURN count(c) AS batchProcessed
  `,

  DELETE_TRUST_LEVEL_NODE: `
    MATCH (t:TrustLevel {value: $value})
    DETACH DELETE t
  `,

  CREATE_TRUST_LEVEL_CONSTRAINT: `
    CREATE CONSTRAINT trust_level_value_unique IF NOT EXISTS
    FOR (t:TrustLevel) REQUIRE t.value IS UNIQUE
  `,

  CREATE_USER_CONSTRAINT: `
    CREATE CONSTRAINT user_key_unique IF NOT EXISTS
    FOR (u:User) REQUIRE u.usernameKey IS UNIQUE
  `,

  FIND_USER: `
    MATCH (u:User {usernameKey: $key})
    RETURN u
  `,

  FIND_ALL_USERS: `
    MATCH (u:User)
    RETURN u
    ORDER BY u.usernameKey
  `,

  CREATE_USER: `
    OPTIONAL MATCH (existing:User {usernameKey: $key})
    WITH existing
    WHERE existing IS NULL
    CREATE (u:User {
      usernameKey: $key,
      username: $username,
      passwordHash: $passwordHash,
      role: $role,
      createdAt: $createdAt,
      disabledAt: $disabledAt
    })
    RETURN u
  `,

  UPDATE_USER: `
    MATCH (u:User {usernameKey: $key})
    SET u.role = CASE WHEN $setRole THEN $role ELSE u.role END,
        u.disabledAt = CASE WHEN $setDisabledAt THEN $disabledAt ELSE u.disabledAt END,
        u.color = CASE WHEN $setColor THEN $color ELSE u.color END
    RETURN u
  `,

  SET_USER_PASSWORD_HASH: `
    MATCH (u:User {usernameKey: $key})
    SET u.passwordHash = $passwordHash
    RETURN u.username AS username
  `,

  FIND_RESEARCH_SUBJECT: `
    MATCH (c:CUIT {id: $taxId})
    RETURN c.businessName AS businessName, c.inMyBase AS inMyBase
  `,

  CREATE_WEB_RESEARCH: `
    MATCH (c:CUIT {id: $taxId})
    CREATE (r:WebResearch {
      id: $id,
      requestedAt: $requestedAt,
      requestedBy: $requestedBy,
      status: $status,
      summary: $summary,
      sources: $sources,
      model: $model,
      inputTokens: $inputTokens,
      outputTokens: $outputTokens,
      cacheReadTokens: $cacheReadTokens,
      webSearches: $webSearches,
      costUsd: $costUsd
    })-[:ABOUT]->(c)
  `,

  FIND_WEB_RESEARCH_FOR_CUIT: `
    MATCH (r:WebResearch)-[:ABOUT]->(c:CUIT {id: $taxId})
    WHERE r.archivedAt IS NULL
    RETURN r, c.id AS taxId, c.businessName AS businessName
    ORDER BY r.requestedAt DESC
  `,

  FIND_RECENT_WEB_RESEARCH: `
    MATCH (r:WebResearch)-[:ABOUT]->(c:CUIT)
    WHERE r.archivedAt IS NULL
    RETURN r, c.id AS taxId, c.businessName AS businessName
    ORDER BY r.requestedAt DESC
    LIMIT $limit
  `,

  FIND_WEB_RESEARCH_BY_ID: `
    MATCH (r:WebResearch {id: $id})-[:ABOUT]->(c:CUIT)
    RETURN r, c.id AS taxId
  `,

  ARCHIVE_WEB_RESEARCH: `
    MATCH (r:WebResearch {id: $id})
    SET r.archivedAt = $archivedAt, r.archivedBy = $archivedBy
  `,

  RESTORE_WEB_RESEARCH: `
    MATCH (r:WebResearch {id: $id})
    REMOVE r.archivedAt, r.archivedBy
  `,

  FIND_ARCHIVED_WEB_RESEARCH: `
    MATCH (r:WebResearch)-[:ABOUT]->(c:CUIT)
    WHERE r.archivedAt IS NOT NULL
    RETURN r, c.id AS taxId, c.businessName AS businessName
    ORDER BY r.archivedAt DESC
    LIMIT $limit
  `,

  SUM_WEB_RESEARCH_SINCE: `
    MATCH (r:WebResearch)
    WHERE r.requestedAt >= $since
    RETURN coalesce(sum(r.costUsd), 0.0) AS totalUsd, count(r) AS count
  `,

  FIND_AI_BUDGET: `
    MATCH (b:AiBudget {id: "monthly"})
    RETURN b.monthlyLimitUsd AS monthlyLimitUsd
  `,

  SET_AI_BUDGET: `
    MERGE (b:AiBudget {id: "monthly"})
    SET b.monthlyLimitUsd = $monthlyLimitUsd,
        b.updatedAt = $updatedAt,
        b.updatedBy = $updatedBy
  `,

  FIND_TRUST_LEVEL_OPTIONS: `
    MATCH (t:TrustLevel)
    RETURN t.value AS value, t.label AS label
  `,

  FIND_EXISTING_CUITS: `
    UNWIND $ids AS id
    MATCH (c:CUIT {id: id})
    RETURN c.id AS id
  `,

  ASSIGN_TRUST_LEVELS: `
    UNWIND $rows AS row
    MATCH (c:CUIT {id: row.taxId})
    SET c.levelOfTrust = row.value,
        c.trustReason = CASE WHEN row.reason = "" THEN coalesce(c.trustReason, "") ELSE row.reason END
    RETURN count(c) AS updated
  `,

  CRM_CONTACT_CONSTRAINT: `
    CREATE CONSTRAINT contact_id_unique IF NOT EXISTS FOR (k:Contact) REQUIRE k.id IS UNIQUE
  `,

  CRM_CHANGE_CONSTRAINT: `
    CREATE CONSTRAINT change_id_unique IF NOT EXISTS FOR (ch:Change) REQUIRE ch.id IS UNIQUE
  `,

  CRM_CHANGE_ENTITY_INDEX: `
    CREATE INDEX change_entity IF NOT EXISTS FOR (ch:Change) ON (ch.entityType, ch.entityId)
  `,

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
    ON CREATE SET c.businessName = $businessName, c.inMyBase = false
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
    MERGE (c)-[:HAS_SOURCE]->(s)
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
    MATCH (c:CUIT {id: $taxId})-[r:HAS_SOURCE]->(:Source {name: $sourceName})
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
    RETURN (EXISTS { MATCH (c)<-[:WORKS_AT|IS]-(:Contact) }
              OR EXISTS { MATCH (c)<-[:ABOUT]-(:Action) }
              OR EXISTS { MATCH (c)<-[:ABOUT]-(:Task) }) AS hasHistory,
           EXISTS { MATCH (c)-[:HAS_SOURCE]->(:Source) } AS hasSource,
           EXISTS { MATCH (c)-[:RELATED_TO]-(:CUIT {inMyBase: true}) } AS relatedToBase,
           COLLECT { MATCH (c)<-[:ABOUT]-(t:Task {status: "open"}) WHERE t.archivedAt IS NULL RETURN t.id } AS openTaskIds
  `,

  CRM_UNLINK_COMPANY: `
    MATCH (c:CUIT {id: $taxId})
    SET c.crmCompany = false,
        c.nosisPending = false,
        c.crmArchivedAt = CASE WHEN $archive THEN $at ELSE c.crmArchivedAt END
  `,

  CRM_DELETE_COMPANY: `
    MATCH (c:CUIT {id: $taxId})
    WHERE NOT EXISTS { MATCH (c)-[:HAS_SOURCE]->(:Source) }
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
      SET c.levelOfTrust = level.value, c.trustReason = $reason
    )
    RETURN inservible
  `,

  CRM_REOPEN_COMPANY: `
    MATCH (c:CUIT {id: $taxId})
    REMOVE c.crmClosedAt, c.crmClosedReason, c.crmClosedBy
  `,

  CRM_FIND_SOURCE: `
    MATCH (s:Source {name: $sourceName})
    WHERE s.name <> $legacySource
    RETURN s.name AS name, s.category AS category
  `,

  CRM_CREATE_CONTACT: `
    CREATE (k:Contact {
      id: $id,
      fullName: $fullName,
      phone: $phone,
      email: $email,
      birthday: $birthday,
      createdAt: $createdAt,
      archivedAt: $archivedAt
    })
  `,

  CRM_UPDATE_CONTACT: `
    MATCH (k:Contact {id: $id})
    SET k.fullName = $fullName,
        k.phone = $phone,
        k.email = $email,
        k.birthday = $birthday,
        k.archivedAt = $archivedAt
  `,

  CRM_LINK_CONTACT: `
    MATCH (k:Contact {id: $id})
    OPTIONAL MATCH (k)-[old:WORKS_AT]->(c:CUIT)
    WHERE NOT c.id IN $companyTaxIds
    DELETE old
    WITH DISTINCT k
    UNWIND $companyTaxIds AS taxId
    MATCH (company:CUIT {id: taxId})
    MERGE (k)-[:WORKS_AT]->(company)
    WITH DISTINCT k
    OPTIONAL MATCH (person:CUIT {id: $cuil})
    FOREACH (_ IN CASE WHEN person IS NULL THEN [] ELSE [1] END | MERGE (k)-[:IS]->(person))
  `,

  CRM_FIND_CONTACT: `
    MATCH (k:Contact {id: $id})
    RETURN k,
           COLLECT { MATCH (k)-[:WORKS_AT]->(c:CUIT) RETURN c.id ORDER BY c.id } AS companyTaxIds,
           head(COLLECT { MATCH (k)-[:IS]->(p:CUIT) RETURN p.id }) AS cuil
  `,

  CRM_LIST_CONTACTS: `
    MATCH (k:Contact)-[:WORKS_AT]->(:CUIT {id: $taxId})
    WHERE k.archivedAt IS NULL
    RETURN k,
           COLLECT { MATCH (k)-[:WORKS_AT]->(c:CUIT) RETURN c.id ORDER BY c.id } AS companyTaxIds,
           head(COLLECT { MATCH (k)-[:IS]->(p:CUIT) RETURN p.id }) AS cuil
    ORDER BY toLower(k.fullName)
  `,

  CRM_WRITE_CHANGE: `
    CREATE (ch:Change {
      id: $id,
      at: $at,
      by: $by,
      entityType: $entityType,
      entityId: $entityId,
      operation: $operation,
      before: $before,
      after: $after
    })
    WITH ch
    OPTIONAL MATCH (u:User {usernameKey: $byKey})
    FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END | CREATE (ch)-[:BY]->(u))
  `,

  CRM_LIST_CHANGES: `
    MATCH (ch:Change {entityType: $entityType, entityId: $entityId})
    RETURN ch
    ORDER BY ch.at DESC
  `,

  CRM_ACTION_CONSTRAINT: `
    CREATE CONSTRAINT action_id_unique IF NOT EXISTS FOR (a:Action) REQUIRE a.id IS UNIQUE
  `,

  CRM_TASK_CONSTRAINT: `
    CREATE CONSTRAINT task_id_unique IF NOT EXISTS FOR (t:Task) REQUIRE t.id IS UNIQUE
  `,

  CRM_TASK_DUE_DATE_INDEX: `
    CREATE INDEX task_due_date IF NOT EXISTS FOR (t:Task) ON (t.dueDate)
  `,

  CRM_LIST_ACTIVE_USERNAMES: `
    MATCH (u:User)
    WHERE u.disabledAt IS NULL
    RETURN u.username AS username, u.color AS color
    ORDER BY u.usernameKey
  `,

  CRM_CONTACTS_AT_COMPANY: `
    UNWIND $contactIds AS contactId
    MATCH (k:Contact {id: contactId})-[:WORKS_AT]->(:CUIT {id: $taxId})
    WHERE k.archivedAt IS NULL
    RETURN k.id AS id
  `,

  CRM_FIND_ACTION: `
    MATCH (a:Action {id: $id})-[:ABOUT]->(c:CUIT)
    RETURN a, c.id AS companyTaxId,
           coalesce(head(COLLECT { MATCH (a)-[:DONE_BY]->(r:Responsible) RETURN r.name }), a.doneBy) AS doneBy,
           coalesce(a.recordedBy, a.doneBy) AS recordedBy,
           COLLECT { MATCH (a)-[:WITH]->(k:Contact) RETURN k.id ORDER BY k.id } AS contactIds,
           head(COLLECT { MATCH (a)-[:CREATES]->(t:Task) RETURN t.id }) AS createdTaskId,
           COLLECT { MATCH (a)-[:COMPLETES]->(t:Task) RETURN t.id ORDER BY t.id } AS completedTaskIds
  `,

  CRM_LIST_ACTIONS: `
    MATCH (c:CUIT {id: $taxId})<-[:ABOUT]-(a:Action)
    WHERE a.archivedAt IS NULL
    RETURN a, c.id AS companyTaxId,
           coalesce(head(COLLECT { MATCH (a)-[:DONE_BY]->(r:Responsible) RETURN r.name }), a.doneBy) AS doneBy,
           coalesce(a.recordedBy, a.doneBy) AS recordedBy,
           COLLECT { MATCH (a)-[:WITH]->(k:Contact) RETURN k.id ORDER BY k.id } AS contactIds,
           head(COLLECT { MATCH (a)-[:CREATES]->(t:Task) RETURN t.id }) AS createdTaskId,
           COLLECT { MATCH (a)-[:COMPLETES]->(t:Task) RETURN t.id ORDER BY t.id } AS completedTaskIds
    ORDER BY a.date DESC, a.createdAt DESC
  `,

  CRM_CREATE_ACTION: `
    MATCH (c:CUIT {id: $companyTaxId})
    CREATE (a:Action {
      id: $id,
      date: $date,
      description: $description,
      doneBy: $doneBy,
      recordedBy: $recordedBy,
      createdAt: $createdAt,
      archivedAt: $archivedAt
    })-[:ABOUT]->(c)
    WITH a
    CALL (a) {
      MATCH (r:Responsible {nameKey: $doneByKey})
      CREATE (a)-[:DONE_BY]->(r)
    }
    CALL (a) {
      UNWIND $contactIds AS contactId
      MATCH (k:Contact {id: contactId})
      CREATE (a)-[:WITH]->(k)
    }
  `,

  CRM_SET_ACTION: `
    MATCH (a:Action {id: $id})
    SET a.date = $date, a.description = $description, a.archivedAt = $archivedAt
    WITH a
    CALL (a) {
      MATCH (a)-[w:WITH]->(k:Contact)
      WHERE NOT k.id IN $contactIds
      DELETE w
    }
    CALL (a) {
      UNWIND $contactIds AS contactId
      MATCH (k:Contact {id: contactId})
      MERGE (a)-[:WITH]->(k)
    }
  `,

  CRM_LINK_ACTION_TASKS: `
    MATCH (a:Action {id: $id})
    CALL (a) {
      MATCH (t:Task {id: $createdTaskId})
      CREATE (a)-[:CREATES]->(t)
    }
    CALL (a) {
      UNWIND $completedTaskIds AS taskId
      MATCH (t:Task {id: taskId})
      CREATE (a)-[:COMPLETES]->(t)
    }
  `,

  CRM_FIND_TASK: `
    MATCH (t:Task {id: $id})-[:ABOUT]->(c:CUIT)
    RETURN t, c.id AS companyTaxId, c.businessName AS businessName,
           coalesce(head(COLLECT { MATCH (t)-[:ASSIGNED_TO]->(r:Responsible) RETURN r.name }), t.assignee) AS assignee,
           COLLECT { MATCH (t)-[:WITH]->(k:Contact) RETURN k.id ORDER BY k.id } AS contactIds
  `,

  CRM_LIST_TASKS: `
    MATCH (c:CUIT {id: $taxId})<-[:ABOUT]-(t:Task)
    WHERE t.archivedAt IS NULL
    RETURN t, c.id AS companyTaxId, c.businessName AS businessName,
           coalesce(head(COLLECT { MATCH (t)-[:ASSIGNED_TO]->(r:Responsible) RETURN r.name }), t.assignee) AS assignee,
           COLLECT { MATCH (t)-[:WITH]->(k:Contact) RETURN k.id ORDER BY k.id } AS contactIds
    ORDER BY t.dueDate, t.createdAt
  `,

  CRM_LIST_AGENDA: `
    MATCH (t:Task {status: "open"})-[:ABOUT]->(c:CUIT)
    WHERE t.archivedAt IS NULL AND c.crmArchivedAt IS NULL AND c.crmClosedAt IS NULL
    WITH t, c, coalesce(head(COLLECT { MATCH (t)-[:ASSIGNED_TO]->(r:Responsible) RETURN r.name }), t.assignee) AS assignee
    WHERE $assigneeKeys IS NULL OR toLower(assignee) IN $assigneeKeys
    RETURN t, c.id AS companyTaxId, c.businessName AS businessName, assignee,
           COLLECT { MATCH (t)-[:WITH]->(k:Contact) RETURN k.id ORDER BY k.id } AS contactIds
  `,

  CRM_CREATE_TASK: `
    MATCH (c:CUIT {id: $companyTaxId})
    CREATE (t:Task {
      id: $id,
      description: $description,
      dueDate: $dueDate,
      status: $status,
      cancelReason: $cancelReason,
      assignee: $assignee,
      createdBy: $createdBy,
      createdAt: $createdAt,
      closedAt: $closedAt,
      archivedAt: $archivedAt
    })-[:ABOUT]->(c)
    WITH t
    CALL (t) {
      MATCH (r:Responsible {nameKey: $assigneeKey})
      CREATE (t)-[:ASSIGNED_TO]->(r)
    }
    CALL (t) {
      UNWIND $contactIds AS contactId
      MATCH (k:Contact {id: contactId})
      CREATE (t)-[:WITH]->(k)
    }
  `,

  CRM_SET_TASK: `
    MATCH (t:Task {id: $id})
    SET t.description = $description,
        t.dueDate = $dueDate,
        t.status = $status,
        t.cancelReason = $cancelReason,
        t.assignee = $assignee,
        t.closedAt = $closedAt,
        t.archivedAt = $archivedAt
    WITH t
    CALL (t) {
      MATCH (t)-[link:ASSIGNED_TO]->(old)
      WHERE NOT old:Responsible OR old.nameKey <> $assigneeKey
      DELETE link
    }
    CALL (t) {
      MATCH (r:Responsible {nameKey: $assigneeKey})
      MERGE (t)-[:ASSIGNED_TO]->(r)
    }
    CALL (t) {
      MATCH (t)-[w:WITH]->(k:Contact)
      WHERE NOT k.id IN $contactIds
      DELETE w
    }
    CALL (t) {
      UNWIND $contactIds AS contactId
      MATCH (k:Contact {id: contactId})
      MERGE (t)-[:WITH]->(k)
    }
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

  CRM_CANCEL_OPEN_TASKS: `
    MATCH (:CUIT {id: $taxId})<-[:ABOUT]-(t:Task {status: "open"})
    WHERE t.archivedAt IS NULL
    SET t.status = "cancelled", t.cancelReason = $cancelReason, t.closedAt = $at
  `,

  RESPONSIBLE_CONSTRAINT: `
    CREATE CONSTRAINT responsible_key_unique IF NOT EXISTS FOR (r:Responsible) REQUIRE r.nameKey IS UNIQUE
  `,

  LIST_RESPONSIBLES: `
    MATCH (r:Responsible)
    RETURN r
    ORDER BY r.nameKey
  `,

  CREATE_RESPONSIBLE: `
    OPTIONAL MATCH (existing:Responsible {nameKey: $nameKey})
    WITH existing
    WHERE existing IS NULL
    CREATE (r:Responsible {
      name: $name,
      nameKey: $nameKey,
      color: $color,
      users: $users,
      disabledAt: null,
      createdAt: $at,
      createdBy: $by
    })
    RETURN r.name AS name
  `,

  UPDATE_RESPONSIBLE: `
    MATCH (r:Responsible {nameKey: $key})
    OPTIONAL MATCH (other:Responsible {nameKey: $nameKey})
    WITH r, other
    WHERE other IS NULL OR other = r
    SET r.name = $name,
        r.nameKey = $nameKey,
        r.color = $color,
        r.users = $users,
        r.disabledAt = CASE WHEN $disabled THEN coalesce(r.disabledAt, $at) ELSE null END
    WITH r
    CALL (r) {
      MATCH (t:Task)-[:ASSIGNED_TO]->(r)
      SET t.assignee = r.name
    }
    CALL (r) {
      MATCH (a:Action)-[:DONE_BY]->(r)
      SET a.doneBy = r.name
    }
    RETURN r.name AS name
  `,
} as const
