import { matchesActivity, parseActivityLine, type ActivityEntry, type ActivityFilters } from "@domain/activityLog.js"

export interface ActivityPage {
  entries: ActivityEntry[]
  hasMore: boolean
}

export class ActivityLogService {
  constructor(
    private readonly lines: () => AsyncIterable<string>,
    private readonly extraEntries: () => Promise<ActivityEntry[]> = async () => []
  ) {}

  async read(filters: ActivityFilters): Promise<ActivityPage> {
    const extra = (await this.extraEntries()).filter((entry) => matchesActivity(entry, filters)).sort((a, b) => a.time.localeCompare(b.time))
    const older: ActivityEntry[] = []
    const atBefore: ActivityEntry[] = []
    let olderCount = 0

    const take = (entry: ActivityEntry): void => {
      if (entry.time === filters.before) {
        atBefore.push(entry)
        return
      }
      olderCount++
      older.push(entry)
      if (older.length > filters.limit) older.shift()
    }

    let next = 0
    for await (const line of this.lines()) {
      const entry = parseActivityLine(line)
      if (!entry || !matchesActivity(entry, filters)) continue
      while (next < extra.length && extra[next]!.time <= entry.time) take(extra[next++]!)
      take(entry)
    }
    while (next < extra.length) take(extra[next++]!)

    const unseen = atBefore.slice(0, Math.max(0, atBefore.length - filters.seenAtBefore))
    const matched = [...older, ...unseen]
    const total = olderCount + unseen.length
    return { entries: matched.slice(-filters.limit).reverse(), hasMore: total > filters.limit }
  }
}
