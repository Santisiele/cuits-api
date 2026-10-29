/** Contacts of CRM companies. */
export const CrmContactQueries = {
  CRM_CONTACT_CONSTRAINT: `
    CREATE CONSTRAINT contact_id_unique IF NOT EXISTS FOR (k:Contact) REQUIRE k.id IS UNIQUE
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

  CRM_CONTACTS_AT_COMPANY: `
    UNWIND $contactIds AS contactId
    MATCH (k:Contact {id: contactId})-[:WORKS_AT]->(:CUIT {id: $taxId})
    WHERE k.archivedAt IS NULL
    RETURN k.id AS id
  `,
} as const
