import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { rotateLogIfLarge } from "@infrastructure/logRotation"

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-rotation-"))
  file = path.join(dir, "activity.log")
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("rotateLogIfLarge", () => {
  it("leaves a small log alone", () => {
    fs.writeFileSync(file, "x")
    expect(rotateLogIfLarge(file, 10)).toBe(false)
    expect(fs.readFileSync(file, "utf8")).toBe("x")
  })

  it("moves a large log aside, shifts the older ones and drops the oldest", () => {
    fs.writeFileSync(`${file}.1`, "one")
    fs.writeFileSync(`${file}.2`, "two")
    fs.writeFileSync(`${file}.3`, "three")
    fs.writeFileSync(file, "current log")
    expect(rotateLogIfLarge(file, 5)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    expect(["", ".1", ".2", ".3"].map((suffix) => (fs.existsSync(file + suffix) ? fs.readFileSync(file + suffix, "utf8") : null))).toEqual([
      null,
      "current log",
      "one",
      "two",
    ])
  })
})
