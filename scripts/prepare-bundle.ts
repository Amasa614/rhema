/**
 * Verifies runtime assets and stages them under src-tauri/bundle-resources/
 * for `tauri build`. NSIS cannot open paths with `..`, so bundle.resources
 * must not use parent-relative paths.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs"
import { dirname, join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const STAGE = join(ROOT, "src-tauri", "bundle-resources")

const REQUIRED: { src: string; dest: string }[] = [
  { src: "data/rhema.db", dest: "rhema.db" },
  {
    src: "embeddings/kjv-qwen3-0.6b.bin",
    dest: "embeddings/kjv-qwen3-0.6b.bin",
  },
  {
    src: "embeddings/kjv-qwen3-0.6b-ids.bin",
    dest: "embeddings/kjv-qwen3-0.6b-ids.bin",
  },
  {
    src: "models/qwen3-embedding-0.6b/tokenizer.json",
    dest: "models/qwen3-embedding-0.6b/tokenizer.json",
  },
  {
    src: "models/qwen3-embedding-0.6b-int8/model_quantized.onnx",
    dest: "models/qwen3-embedding-0.6b-int8/model_quantized.onnx",
  },
]

function stageFile(srcRel: string, destRel: string): void {
  const src = join(ROOT, srcRel)
  const dest = join(STAGE, destRel)
  if (!existsSync(src)) {
    throw new Error(`Missing: ${srcRel}`)
  }
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
}

console.log("\n📦 Checking bundle resources...\n")

const missing: string[] = []
for (const { src } of REQUIRED) {
  const path = join(ROOT, src)
  if (existsSync(path)) {
    console.log(`  ✓ ${src}`)
  } else {
    missing.push(src)
    console.log(`  ✗ ${src}`)
  }
}

if (missing.length > 0) {
  console.error(
    `\nMissing files. Run: bun run setup:all (and bun run build:bible for Twi)\n`,
  )
  process.exit(1)
}

console.log("\n📁 Staging bundle resources for NSIS/WiX...\n")
rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })
for (const { src, dest } of REQUIRED) {
  stageFile(src, dest)
  console.log(`  → bundle-resources/${dest}`)
}

console.log("\n✓ All bundle resources present and staged.\n")
