/**
 * Maps Nosis internal relationship type codes to human-readable English names.
 * Extend this record as new codes are discovered.
 */
export const RELATIONSHIP_TYPES: Record<number, string> = {
  1: "Principal",
  4: "Check Signer",
  8: "Employer",
  20: "President",
  21: "Director",
  27: "Administrator",
  33: "Former President",
  51: "Vice President",
  95: "Deputy Director",
  135: "Former Vice President",
  161: "Deputy Administrator",
  164: "Brand Owner",
  176: "Employee",
  1001: "Child",
  1002: "Parent",
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