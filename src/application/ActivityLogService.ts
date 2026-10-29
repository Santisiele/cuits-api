import { matchesActivity, parseActivityLine, type ActivityEntry, type ActivityFilters } from "@domain/activityLog.js"

export interface ActivityPage {
  entries: ActivityEntry[]
  hasMore: boolean
}

export class ActivityLogService {
  constructor(private readonly lines: () => AsyncIterable<string>) {}

  async read(filters: ActivityFilters): Promise<ActivityPage> {
    const kept: ActivityEntry[] = []
    let matched = 0
    for await (const line of this.lines()) {
      const entry = parseActivityLine(line)
      if (!entry || !matchesActivity(entry, filters)) continue
      matched++
      kept.push(entry)
      if (kept.length > filters.limit) kept.shift()
    }
    return { entries: kept.reverse(), hasMore: matched > filters.limit }
  }
}
