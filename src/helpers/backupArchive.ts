import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"

const MAGIC = Buffer.from("CUITBK01")
const SALT_LENGTH = 16
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32

function keyFrom(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH)
}

export function packBackup(json: string, passphrase: string): Buffer {
  if (passphrase.length === 0) throw new Error("A passphrase is required to pack a backup")

  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv("aes-256-gcm", keyFrom(passphrase, salt), iv)
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(json, "utf8"), { level: 9 })), cipher.final()])

  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body])
}

export function unpackBackup(archive: Buffer, passphrase: string): string {
  if (archive.length < MAGIC.length + SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error("That file is too short to be a backup")
  }
  if (!archive.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("That file is not a backup written by this app")
  }

  let at = MAGIC.length
  const salt = archive.subarray(at, (at += SALT_LENGTH))
  const iv = archive.subarray(at, (at += IV_LENGTH))
  const tag = archive.subarray(at, (at += TAG_LENGTH))
  const body = archive.subarray(at)

  const decipher = createDecipheriv("aes-256-gcm", keyFrom(passphrase, salt), iv)
  decipher.setAuthTag(tag)

  try {
    return gunzipSync(Buffer.concat([decipher.update(body), decipher.final()])).toString("utf8")
  } catch {
    throw new Error("Wrong passphrase, or the backup is damaged")
  }
}
