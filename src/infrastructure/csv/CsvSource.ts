import fs from "fs"
import path from "path"
import { parse } from "csv-parse/sync"
import type { ISource } from "@ports/interfaces.js"
import type { SearchResult } from "@domain/entities.js"

/**
 * Data source adapter for local CSV files.
 *
 * Supports semicolon-separated files encoded in Latin-1.
 * Each row must have at minimum a `CUIT` column.
 */
export class CsvSource implements ISource {
  readonly name: string
  private readonly filePath: string

  /**
   * @param name - Unique identifier for this source (e.g. "csv-poseidon")
   * @param filePath - Absolute path to the CSV file
   */
  constructor(name: string, filePath: string) {
    this.name = name
    this.filePath = filePath
  }

  /**
   * Searches for a Tax ID in the CSV file.
   * Reads and parses the file on every call (suitable for small files).
   *
   * @param taxId - The CUIT to search for
   */
  async search(taxId: string): Promise<SearchResult[]> {
    const content = fs.readFileSync(this.filePath, { encoding: "latin1" })

    const records = parse(content, {
      delimiter: ";",
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[]

    const fileName = path.basename(this.filePath)

    return records
      .filter((row) => row["CUIT"] === taxId)
      .map((row) => ({
        cuit: taxId,
        source: this.name,
        file: fileName,
        data: {
          fullName: row["Nombre completo"],
          phone: row["Telefono"],
          email: row["E-mail"],
        },
      }))
  }
}