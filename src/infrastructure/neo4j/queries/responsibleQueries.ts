/** Responsibles: the people tasks and actions are attributed to. */
export const ResponsibleQueries = {
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
