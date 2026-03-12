import type { FastifyReply } from "fastify"
import type { ISource, SearchResult } from "@sources/ISource.js"

export const CUIT_REGEX = /^\d{2}-\d{8}-\d{1}$/

/**
 * Validates CUIT format
 * @param cuit - CUIT to validate
 * @returns true if valid
 */
export function isValidCuit(cuit: string): boolean {
  return CUIT_REGEX.test(cuit)
}

/**
 * Searches for a CUIT across all sources, ignoring individual source failures
 * @param cuit - CUIT to search for
 * @param sources - List of data sources to search
 */
export async function searchAllSources(
  cuit: string,
  sources: ISource[]
): Promise<{ results: SearchResult[]; failedCount: number }> {
  const allResults = await Promise.allSettled(
    sources.map((source) => source.search(cuit))
  )

  const results = allResults
    .filter((r): r is PromiseFulfilledResult<SearchResult[]> => r.status === "fulfilled")
    .flatMap((r) => r.value)

  const failedCount = allResults.filter((r) => r.status === "rejected").length

  return { results, failedCount }
}

/**
 * Builds and sends the appropriate response based on search results
 */
export async function handleCuitSearch(
  cuit: string,
  sources: ISource[],
  reply: FastifyReply
) {
  if (!isValidCuit(cuit)) {
    return reply.code(400).send({
      message: "Invalid CUIT format. Expected: XX-XXXXXXXX-X",
    })
  }

  const { results, failedCount } = await searchAllSources(cuit, sources)

  if (failedCount === sources.length) {
    return reply.code(500).send({ message: "All sources failed" })
  }

  if (results.length === 0) {
    return reply.code(404).send({
      cuit,
      found: false,
      message: "CUIT not found in any source",
    })
  }

  return reply.send({ cuit, found: true, results })
}