/**
 * Verifies runtime assets exist before `tauri build` / dev compile.
 * Paths match src-tauri/tauri.conf.json bundle.resources (repo root, not src-tauri/bundle/).
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

const REQUIRED = [
  "data/rhema.db",
  "embeddings/kjv-qwen3-0.6b.bin",
  "embeddings/kjv-qwen3-0.6b-ids.bin",
  "models/qwen3-embedding-0.6b/tokenizer.json",
  "models/qwen3-embedding-0.6b-int8/model_quantized.onnx",
]

console.log("\n📦 Checking bundle resources...\n")

const missing: string[] = []
for (const rel of REQUIRED) {
  const path = join(ROOT, rel)
  if (existsSync(path)) {
    console.log(`  ✓ ${rel}`)
  } else {
    missing.push(rel)
    console.log(`  ✗ ${rel}`)
  }
}

if (missing.length > 0) {
  console.error(
    `\nMissing files. Run: bun run setup:all (and bun run build:bible for Twi)\n`
  )
  process.exit(1)
}

console.log("\n✓ All bundle resources present.\n")
