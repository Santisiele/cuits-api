import { matchesActivity, parseActivityLine, type ActivityEntry, type ActivityFilters } from "@domain/activityLog.js"

export interface ActivityPage {
  entries: ActivityEntry[]
  hasMore: boolean
}

export class ActivityLogService {
  constructor(private readonly lines: () => AsyncIterable<string>) {}

  async read(filters: ActivityFilters): Promise<ActivityPage> {
    const older: ActivityEntry[] = []
    const atBefore: ActivityEntry[] = []
    let olderCount = 0
    for await (const line of this.lines()) {
      const entry = parseActivityLine(line)
      if (!entry || !matchesActivity(entry, filters)) continue
      if (entry.time === filters.before) {
        atBefore.push(entry)
        continue
      }
      olderCount++
      older.push(entry)
      if (older.length > filters.limit) older.shift()
    }
    const unseen = atBefore.slice(0, Math.max(0, atBefore.length - filters.seenAtBefore))
    const matched = [...older, ...unseen]
    const total = olderCount + unseen.length
    return { entries: matched.slice(-filters.limit).reverse(), hasMore: total > filters.limit }
  }
}
