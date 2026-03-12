import fs from "fs"
import path from "path"
import { parse } from "csv-parse/sync"
import type { ISource, SearchResult } from "@sources/ISource.js"

/**
 * Data source adapter for local CSV files.
 * Supports semicolon-separated files encoded in Latin-1.
 */
export class CsvSource implements ISource {
  name: string
  private filePath: string

  /**
   * @param name - Unique identifier for this source
   * @param filePath - Absolute or relative path to the CSV file
   */
  constructor(name: string, filePath: string) {
    this.name = name
    this.filePath = filePath
  }

  /**
   * Searches for a CUIT in the CSV file.
   * @param cuit - The CUIT to search for
   * @returns Array of results where the CUIT was found
   */
  async search(cuit: string): Promise<SearchResult[]> {
    const content = fs.readFileSync(this.filePath, { encoding: "latin1" })

    const records = parse(content, {
      delimiter: ";",
      columns: true,
      skip_empty_lines: true,
      trim: true,
    })

    const fileName = path.basename(this.filePath)

    const rows = records as Record<string, string>[]

    return rows
      .filter((row) => row["CUIT"] === cuit)
      .map((row) => ({
        cuit,
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