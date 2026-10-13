import neo4j, { type Session } from "neo4j-driver"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import type { IBirthdayProgressRepository, IBirthdaySweepMirror } from "@ports/interfaces.js"
import {
  parseMisses,
  type BirthdaySweepSnapshot,
  type PendingPerson,
  type PeopleCount,
  type PersonName,
  type SourceProgress,
} from "@domain/birthdayProgress.js"

function toNumber(value: unknown): number {
  if (neo4j.isInt(value)) return value.toNumber()
  return typeof value === "number" ? value : 0
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function toTexts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export class Neo4jBirthdaySweepRepository implements IBirthdaySweepMirror, IBirthdayProgressRepository {
  private async run<T>(work: (session: Session) => Promise<T>): Promise<T> {
    const session = Neo4jDriver.instance.session()
    try {
      return await work(session)
    } finally {
      await session.close()
    }
  }

  saveSweep(snapshot: BirthdaySweepSnapshot): Promise<void> {
    return this.run(async (session) => {
      await session.run(Queries.SAVE_BIRTHDAY_SWEEP, {
        day: snapshot.day,
        consultedToday: neo4j.int(snapshot.consultedToday),
        dailyLimit: neo4j.int(snapshot.dailyLimit),
        misses: JSON.stringify(snapshot.misses),
        updatedAt: snapshot.updatedAt,
      })
    })
  }

  findSweep(): Promise<BirthdaySweepSnapshot | null> {
    return this.run(async (session) => {
      const record = (await session.run(Queries.FIND_BIRTHDAY_SWEEP)).records[0]
      if (!record) return null
      return {
        day: toText(record.get("day")),
        consultedToday: toNumber(record.get("consultedToday")),
        dailyLimit: toNumber(record.get("dailyLimit")),
        misses: parseMisses(record.get("misses")),
        updatedAt: toText(record.get("updatedAt")),
      }
    })
  }

  countPeople(): Promise<PeopleCount> {
    return this.run(async (session) => {
      const record = (await session.run(Queries.COUNT_KNOWN_PEOPLE_BIRTHDAYS)).records[0]
      return {
        knownPeople: toNumber(record?.get("knownPeople")),
        withBirthday: toNumber(record?.get("withBirthday")),
      }
    })
  }

  countBySource(): Promise<SourceProgress[]> {
    return this.run(async (session) => {
      const result = await session.run(Queries.COUNT_BIRTHDAYS_BY_SOURCE)
      return result.records.map((record) => ({
        source: toText(record.get("source")),
        people: toNumber(record.get("people")),
        withBirthday: toNumber(record.get("withBirthday")),
        missing: toNumber(record.get("missing")),
      }))
    })
  }

  findNames(taxIds: string[]): Promise<PersonName[]> {
    if (taxIds.length === 0) return Promise.resolve([])
    return this.run(async (session) => {
      const result = await session.run(Queries.FIND_CUIT_NAMES, { taxIds })
      return result.records.map((record) => ({
        taxId: toText(record.get("taxId")),
        businessName: toText(record.get("businessName")),
      }))
    })
  }

  findPending(skip: string[]): Promise<PendingPerson[]> {
    return this.run(async (session) => {
      const result = await session.run(Queries.FIND_PEOPLE_PENDING_BIRTHDAY, { skip })
      return result.records.map((record) => ({
        taxId: toText(record.get("taxId")),
        businessName: toText(record.get("businessName")),
        sources: toTexts(record.get("sources")),
      }))
    })
  }
}
