// Verifies a Tauri updater (minisign) signature against the public key that is
// embedded in the app (apps/desktop/src-tauri/tauri.conf.json), independently
// of Tauri. Used by the release workflow before publishing, and for audits.
//
//   node scripts/verify-update-signature.mjs <installer.exe> <signature | file.sig | latest.json>
//
// Exit code 0 = valid, 1 = invalid or malformed.
import { createHash, createPublicKey, verify } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const conf = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"))
const fail = (msg) => {
  console.error(`INVALID: ${msg}`)
  process.exit(1)
}

/** Tauri stores minisign files base64-encoded; returns the decoded lines. */
const lines = (b64) => Buffer.from(b64.trim(), "base64").toString("utf8").split(/\r?\n/).filter(Boolean)

export function verifyMinisign(file, sigB64, pubB64) {
  const pub = Buffer.from(lines(pubB64)[1] ?? "", "base64")
  if (pub.length !== 42 || pub.subarray(0, 2).toString() !== "Ed") throw new Error("malformed public key")
  const [, sigLine, trusted, globalLine] = lines(sigB64)
  const sig = Buffer.from(sigLine ?? "", "base64")
  if (sig.length !== 74) throw new Error("malformed signature")
  const alg = sig.subarray(0, 2).toString()
  if (alg !== "ED" && alg !== "Ed") throw new Error(`unknown algorithm ${alg}`)
  if (!sig.subarray(2, 10).equals(pub.subarray(2, 10))) throw new Error("signature was made with a different key")
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.subarray(10)]),
    format: "der",
    type: "spki",
  })
  const message = alg === "ED" ? createHash("blake2b512").update(file).digest() : file
  if (!verify(null, message, key, sig.subarray(10))) throw new Error("file signature does not verify")
  if (!trusted?.startsWith("trusted comment: ")) throw new Error("missing trusted comment")
  const globalSig = Buffer.from(globalLine ?? "", "base64")
  const signed = Buffer.concat([sig.subarray(10), Buffer.from(trusted.slice("trusted comment: ".length))])
  if (!verify(null, signed, key, globalSig)) throw new Error("trusted comment signature does not verify")
  return { keyId: Buffer.from(pub.subarray(2, 10)).reverse().toString("hex").toUpperCase(), trusted: trusted.slice(17) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [installer, sigArg] = process.argv.slice(2)
  if (!installer || !sigArg) fail("usage: verify-update-signature.mjs <installer> <signature|file.sig|latest.json>")
  let sig = sigArg
  if (existsSync(sigArg)) {
    const text = readFileSync(sigArg, "utf8")
    sig = sigArg.endsWith(".json") ? JSON.parse(text).platforms?.["windows-x86_64"]?.signature ?? "" : text
  }
  try {
    const r = verifyMinisign(readFileSync(installer), sig, conf.plugins.updater.pubkey)
    console.log(`VALID: signed by key ${r.keyId} (${r.trusted})`)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }
}
