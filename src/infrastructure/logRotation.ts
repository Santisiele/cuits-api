import fs from "fs"
import { rotatedLogNames } from "@domain/activityLog.js"

export function rotateLogIfLarge(file: string, maxBytes: number): boolean {
  if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) return false
  const names = rotatedLogNames(file)
  if (fs.existsSync(names.at(-1)!)) fs.rmSync(names.at(-1)!)
  for (let index = names.length - 2; index >= 0; index--) {
    if (fs.existsSync(names[index]!)) fs.renameSync(names[index]!, names[index + 1]!)
  }
  fs.renameSync(file, names[0]!)
  return true
}
