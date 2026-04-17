/**
 * Maps Nosis internal relationship type codes to human-readable English names.
 * Extend this record as new codes are discovered.
 */
export const RELATIONSHIP_TYPES: Record<number, string> = {
  1: "Principal",
  4: "Check Signer",
  5: "Parent",
  6: "Child",
  8: "Employer",
  9: "Spouse",
  11: "Concubine",
  12: "Familiar",
  13: "Proxy",
  14: "Proxy",
  19: "Shareholder",
  20: "President",
  21: "Director",
  22: "Manager",
  27: "Administrator",
  28: "Counselor",
  33: "Former President",
  37: "Inspector",
  39: "Unspecified Authority",
  40: "Member",
  43: "Protreasurer",
  44: "Legal Representative",
  46: "Secretary",
  47: "Auditor",
  49: "Treasurer",
  50: "Vice Principal",
  51: "Vice President",
  52: "Vocal",
  95: "Deputy Director",
  96: "Deputy Manager",
  97: "Alternate Legal Representative",
  98: "Assistant Manager",
  100: "Split Company",
  104: "Former Partner",
  114: "Former Director",
  115: "Former Manager",
  118: "Former Administrator",
  126: "Former Member",
  127: "Former Owner",
  129: "Former Legal Representative",
  131: "Former Auditor",
  135: "Former Vice President",
  136: "Former Vocal",
  137: "Former Deputy Director",
  138: "Former Deputy Manager",
  143: "Linked Company",
  144: "Bound",
  145: "Notary",
  146: "Lawyer",
  149: "Alternate Auditor",
  153: "Assignor",
  154: "Assignee",
  155: "Former Deputy Auditor",
  160: "Dean",
  161: "Deputy Administrator",
  163: "Deputy Vice President",
  164: "Brand Owner",
  168: "Former Deputy Administrator",
  169: "Former Bound",
  170: "Auditor",
  171: "Internal Auditor",
  172: "External Auditor",
  175: "Former External Auditor",
  176: "Employee",
  1003: "Brother",
  1004: "Sister",
  1005: "Cousin",
  1006: "Friend",
}

/**
 * Returns the human-readable name for a Nosis relationship type code.
 * Falls back to `"Unknown (code)"` if the code is not mapped.
 *
 * @param code - Nosis relationship type code
 */
export function getRelationshipTypeName(code: number): string {
  return RELATIONSHIP_TYPES[code] ?? `Unknown (${code})`
}