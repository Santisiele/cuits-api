/**
 * Maps Nosis internal relationship type codes to human-readable names.
 * New codes are added as they are discovered.
 */
export const RELATIONSHIP_TYPES: Record<number, string> = {
  1: "Principal",
  4: "Check Signer",
  8: "Employer",
  20: "President",
  21: "Director",
  51: "Vice President",
  95: "Deputy Director",
  164: "Brand Owner",
  176: "Employee"
}

/**
 * Returns the human-readable name for a relationship type code.
 * Falls back to the raw code if unknown.
 * @param code - Nosis relationship type code
 */
export function getRelationshipTypeName(code: number): string {
  return RELATIONSHIP_TYPES[code] ?? `Unknown (${code})`
}