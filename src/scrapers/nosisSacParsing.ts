const TOKEN_PATTERN = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i
const VI_IDENTIFIER_PATTERN = /data-identificador="([^"]+)"\s+data-prefijo="VI"/i
const BIRTHDAY_PATTERN = /F\.\s*nacimiento:\s*<\/td>\s*<td>\s*(\d{1,2}\/\d{1,2}\/\d{4})/i

export function extractVerificationToken(html: string): string | null {
  return TOKEN_PATTERN.exec(html)?.[1] ?? null
}

export function extractViIdentifier(html: string): string | null {
  return VI_IDENTIFIER_PATTERN.exec(html)?.[1] ?? null
}

export function extractBirthday(html: string): string | null {
  const raw = BIRTHDAY_PATTERN.exec(html)?.[1]
  return raw ? normaliseDate(raw) : null
}

export function normaliseDate(raw: string): string {
  const [day, month, year] = raw.split("/")
  if (!day || !month || !year) return raw
  return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`
}
