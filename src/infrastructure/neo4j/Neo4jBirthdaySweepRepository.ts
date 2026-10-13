import neo4j, { type Session } from "neo4j-driver"
import { Neo4jDriver } from "@infrastructure/neo4j/Neo4jDriver.js"
import { Queries } from "@infrastructure/neo4j/queries.js"
import type { IBirthdaySweepMirror } from "@ports/interfaces.js"
import type { BirthdaySweepSnapshot } from "@domain/birthdayProgress.js"

export class Neo4jBirthdaySweepRepository implements IBirthdaySweepMirror {
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
}
