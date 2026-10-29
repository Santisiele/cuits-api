export interface BackupNode {
  key: string
  labels: string[]
  properties: Record<string, unknown>
}

export interface BackupRelationship {
  from: string
  to: string
  type: string
  properties: Record<string, unknown>
}

export interface GraphBackup {
  exportedAt: string
  nodes: BackupNode[]
  relationships: BackupRelationship[]
}

export interface IntSentinel {
  $int: string
}

export interface DateTimeParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  nanosecond: number
  timeZoneOffsetSeconds: number | null
  timeZoneId: string | null
}

export interface DateTimeSentinel {
  $datetime: DateTimeParts
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/

const DATE_TIME_FIELDS = ["year", "month", "day", "hour", "minute", "second", "nanosecond"] as const

export function intSentinel(value: string): IntSentinel {
  return { $int: value }
}

export function isIntSentinel(value: unknown): value is IntSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IntSentinel).$int === "string" &&
    /^-?\d+$/.test((value as IntSentinel).$int)
  )
}

function toWholeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value !== "object" || value === null) return null
  const { low, high } = value as { low?: unknown; high?: unknown }
  if (typeof low !== "number" || typeof high !== "number") return null
  return high * 2 ** 32 + (low >>> 0)
}

export function readDateTimeParts(value: unknown): DateTimeParts | null {
  if (typeof value !== "object" || value === null) return null
  const fields = value as Record<string, unknown>
  const parts: Partial<Record<(typeof DATE_TIME_FIELDS)[number], number>> = {}
  for (const field of DATE_TIME_FIELDS) {
    const number = toWholeNumber(fields[field])
    if (number === null) return null
    parts[field] = number
  }
  const offset = fields["timeZoneOffsetSeconds"] == null ? null : toWholeNumber(fields["timeZoneOffsetSeconds"])
  const zone = typeof fields["timeZoneId"] === "string" ? fields["timeZoneId"] : null
  if (offset === null && zone === null) return null
  return { ...(parts as Omit<DateTimeParts, "timeZoneOffsetSeconds" | "timeZoneId">), timeZoneOffsetSeconds: offset, timeZoneId: zone }
}

export function dateTimeSentinel(parts: DateTimeParts): DateTimeSentinel {
  return { $datetime: parts }
}

export function dateTimePartsOf(value: unknown): DateTimeParts | null {
  if (typeof value === "object" && value !== null && "$datetime" in value) {
    return readDateTimeParts((value as DateTimeSentinel).$datetime)
  }
  return readDateTimeParts(value)
}

export function isSafeGraphName(name: string): boolean {
  return NAME_PATTERN.test(name)
}

export function groupByLabels(nodes: BackupNode[]): Map<string, BackupNode[]> {
  const groups = new Map<string, BackupNode[]>()
  for (const node of nodes) {
    const key = [...node.labels].sort().join(":")
    const group = groups.get(key)
    if (group) group.push(node)
    else groups.set(key, [node])
  }
  return groups
}

export function groupByType(relationships: BackupRelationship[]): Map<string, BackupRelationship[]> {
  const groups = new Map<string, BackupRelationship[]>()
  for (const relationship of relationships) {
    const group = groups.get(relationship.type)
    if (group) group.push(relationship)
    else groups.set(relationship.type, [relationship])
  }
  return groups
}

export function summarise(backup: GraphBackup): string {
  return `${backup.nodes.length} nodes and ${backup.relationships.length} relationships`
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("A batch needs at least one item")
  const batches: T[][] = []
  for (let at = 0; at < items.length; at += size) batches.push(items.slice(at, at + size))
  return batches
}

export function parseBackup(json: string): GraphBackup {
  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    throw new Error("The backup is not readable JSON")
  }

  const backup = payload as Partial<GraphBackup>
  if (!Array.isArray(backup.nodes) || !Array.isArray(backup.relationships)) {
    throw new Error("The backup has no nodes or no relationships")
  }
  for (const node of backup.nodes) {
    if (typeof node?.key !== "string" || !Array.isArray(node.labels)) {
      throw new Error("The backup has a node without a key or labels")
    }
    for (const label of node.labels) {
      if (!isSafeGraphName(label)) throw new Error(`The backup has an unsafe label: ${String(label)}`)
    }
  }
  for (const relationship of backup.relationships) {
    if (typeof relationship?.from !== "string" || typeof relationship?.to !== "string") {
      throw new Error("The backup has a relationship without both ends")
    }
    if (!isSafeGraphName(relationship.type)) {
      throw new Error(`The backup has an unsafe relationship type: ${String(relationship.type)}`)
    }
  }

  return {
    exportedAt: typeof backup.exportedAt === "string" ? backup.exportedAt : "",
    nodes: backup.nodes,
    relationships: backup.relationships,
  }
}
