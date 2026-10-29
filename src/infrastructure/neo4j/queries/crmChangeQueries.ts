/** The change history every CRM write leaves. */
export const CrmChangeQueries = {
  CRM_CHANGE_CONSTRAINT: `
    CREATE CONSTRAINT change_id_unique IF NOT EXISTS FOR (ch:Change) REQUIRE ch.id IS UNIQUE
  `,

  CRM_CHANGE_ENTITY_INDEX: `
    CREATE INDEX change_entity IF NOT EXISTS FOR (ch:Change) ON (ch.entityType, ch.entityId)
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
} as const
