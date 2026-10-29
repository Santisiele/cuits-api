/** Actions, tasks and the agenda. */
export const CrmWorkQueries = {
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
           COLLECT { MATCH (t)-[:WITH]->(k:Contact) RETURN k.id ORDER BY k.id } AS contactIds,
           coalesce(
             head(COLLECT {
               MATCH (a:Action)-[:CREATES]->(t) WHERE a.archivedAt IS NULL
               RETURN a {
                 .date, .description,
                 doneBy: coalesce(head(COLLECT { MATCH (a)-[:DONE_BY]->(r:Responsible) RETURN r.name }), a.doneBy),
                 contacts: COLLECT { MATCH (a)-[:WITH]->(k:Contact) RETURN k.fullName ORDER BY k.fullName }
               }
             }),
             head(COLLECT {
               MATCH (c)<-[:ABOUT]-(a:Action) WHERE a.archivedAt IS NULL
               WITH a ORDER BY a.date DESC, a.createdAt DESC LIMIT 1
               RETURN a {
                 .date, .description,
                 doneBy: coalesce(head(COLLECT { MATCH (a)-[:DONE_BY]->(r:Responsible) RETURN r.name }), a.doneBy),
                 contacts: COLLECT { MATCH (a)-[:WITH]->(k:Contact) RETURN k.fullName ORDER BY k.fullName }
               }
             })
           ) AS lastAction
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
    WHERE t.status = $expectedStatus AND coalesce(t.archivedAt, "") = coalesce($expectedArchivedAt, "")
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
    RETURN count(t) AS updated
  `,

  CRM_COMPLETE_TASK: `
    MATCH (t:Task {id: $id})
    WHERE t.status = "open" AND t.archivedAt IS NULL
    SET t.status = "done", t.closedAt = $closedAt
    RETURN count(t) AS completed
  `,

  CRM_CANCEL_OPEN_TASKS: `
    MATCH (:CUIT {id: $taxId})<-[:ABOUT]-(t:Task {status: "open"})
    WHERE t.archivedAt IS NULL
    SET t.status = "cancelled", t.cancelReason = $cancelReason, t.closedAt = $at
    RETURN t.id AS id
  `,
} as const
