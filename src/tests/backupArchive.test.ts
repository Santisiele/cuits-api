import { describe, it, expect } from "vitest"
import { packBackup, unpackBackup } from "@helpers/backupArchive"

const PASSPHRASE = "una clave larga y secreta"
const JSON_PAYLOAD = JSON.stringify({ exportedAt: "2026-09-24T18:00:00.000Z", nodes: [{ key: "1" }] })

describe("packBackup / unpackBackup", () => {
  it("gives back exactly what it was given", () => {
    expect(unpackBackup(packBackup(JSON_PAYLOAD, PASSPHRASE), PASSPHRASE)).toBe(JSON_PAYLOAD)
  })

  it("survives accents and emoji", () => {
    const payload = JSON.stringify({ name: "Ñandú S.A. — cumpleaños 🎂" })
    expect(unpackBackup(packBackup(payload, PASSPHRASE), PASSPHRASE)).toBe(payload)
  })

  it("does not leave the contents readable in the file", () => {
    const archive = packBackup(JSON.stringify({ businessName: "CHAMMAS SOC RESP LTDA" }), PASSPHRASE)
    expect(archive.toString("latin1")).not.toContain("CHAMMAS")
  })

  it("compresses, so a big backup still fits in an email", () => {
    const repetitive = JSON.stringify({ nodes: Array.from({ length: 2000 }, () => ({ label: "CUIT" })) })
    expect(packBackup(repetitive, PASSPHRASE).length).toBeLessThan(repetitive.length / 10)
  })

  it("writes a different file every time, even for the same data", () => {
    const first = packBackup(JSON_PAYLOAD, PASSPHRASE)
    const second = packBackup(JSON_PAYLOAD, PASSPHRASE)
    expect(first.equals(second)).toBe(false)
  })

  it("refuses the wrong passphrase instead of returning rubbish", () => {
    const archive = packBackup(JSON_PAYLOAD, PASSPHRASE)
    expect(() => unpackBackup(archive, "otra clave")).toThrow(/passphrase/i)
  })

  it("notices a file that was tampered with", () => {
    const archive = packBackup(JSON_PAYLOAD, PASSPHRASE)
    archive.writeUInt8(archive[archive.length - 1]! ^ 0xff, archive.length - 1)
    expect(() => unpackBackup(archive, PASSPHRASE)).toThrow()
  })

  it("refuses a file that is not one of ours", () => {
    expect(() => unpackBackup(Buffer.alloc(200, 7), PASSPHRASE)).toThrow(
      /not a backup/i
    )
  })

  it("refuses a file too short to be a backup", () => {
    expect(() => unpackBackup(Buffer.from("corto"), PASSPHRASE)).toThrow(/too short/i)
  })

  it("refuses to pack without a passphrase", () => {
    expect(() => packBackup(JSON_PAYLOAD, "")).toThrow(/passphrase/i)
  })
})
