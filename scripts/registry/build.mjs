// Builds and signs the Vidra model registry from the verified manifests.
//
//   node scripts/registry/build.mjs            # build + sign registry/v1/catalog.json
//   node scripts/registry/build.mjs --verify   # verify the committed signature only
//
// Signing key: Ed25519 PKCS#8 PEM from $VIDRA_REGISTRY_KEY or
// .signing/registry-ed25519.pem (git-ignored, NEVER commit it). The app embeds
// only the public key (registry/PUBLIC_KEY.txt). The registry contains data
// only — manifests in the format of packages/core/src/registry.ts — and is
// re-validated by the app; nothing in it is ever executed.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const out = join(root, "registry", "v1", "catalog.json")
const sigPath = `${out}.sig`
const publicKeyB64 = readFileSync(join(root, "registry", "PUBLIC_KEY.txt"), "utf8").trim()

function publicKey() {
  // SPKI DER prefix for a raw 32-byte Ed25519 key.
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyB64, "base64")])
  return createPublicKey({ key: der, format: "der", type: "spki" })
}

function verifyFile() {
  const data = readFileSync(out)
  const sig = Buffer.from(readFileSync(sigPath, "utf8").trim(), "base64")
  if (!verify(null, data, publicKey(), sig)) throw new Error("registry signature INVALID")
  return JSON.parse(data.toString("utf8"))
}

if (process.argv.includes("--verify")) {
  const catalog = verifyFile()
  console.log(`signature OK — registry ${catalog.version}, ${Object.values(catalog.providers).reduce((n, m) => n + m.models.length, 0)} models`)
  process.exit(0)
}

const pkg = JSON.parse(readFileSync(join(root, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"))
const manifestsDir = join(root, "packages", "core", "manifests")
const providers = {}
let newest = "0000.00.00"
for (const file of readdirSync(manifestsDir).filter((f) => f.endsWith(".json")).sort()) {
  const manifest = JSON.parse(readFileSync(join(manifestsDir, file), "utf8"))
  providers[manifest.provider] = { ...manifest, source: "registry" }
  if (manifest.version > newest) newest = manifest.version
}

const catalog = {
  format: "vidra.registry",
  formatVersion: 1,
  /** Monotonic: the app refuses registries older than the one it has. */
  version: `${newest}.${Date.now()}`,
  generatedAt: new Date().toISOString(),
  /** Oldest app version whose adapters can execute every model listed. */
  minAppVersion: pkg.version,
  manifestFormatVersion: 2,
  providers,
  /** Model ids the providers have retired. */
  discontinued: [],
}

const keyPath = process.env.VIDRA_REGISTRY_KEY ?? join(root, ".signing", "registry-ed25519.pem")
const privateKey = createPrivateKey(readFileSync(keyPath))
const derived = createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32).toString("base64")
if (derived !== publicKeyB64) throw new Error("signing key does not match registry/PUBLIC_KEY.txt")

const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + "\n", "utf8")
writeFileSync(out, bytes)
writeFileSync(sigPath, sign(null, bytes, privateKey).toString("base64") + "\n")
verifyFile()
console.log(`signed ${out} (version ${catalog.version})`)
