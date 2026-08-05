/**
 * Downloads Asante Twi Bible (Biblica Nkwa Asɛm) from eBible.org (CC BY-SA 4.0)
 * and converts USFM to Scrollmapper-style JSON for build-bible-db.ts.
 *
 * Run: bun run download:twi-bible
 * Then: bun run build:bible
 *
 * License: https://ebible.org/find/details.php?id=twiasante
 */

import { mkdir, readdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

const DATA_DIR = import.meta.dir
const SOURCES_DIR = join(DATA_DIR, "sources")
const OUT_JSON = join(SOURCES_DIR, "TwiAsante.json")
const STAGING = join(DATA_DIR, ".twi-usfm-staging")

const TWI_USFM_ZIP =
  "https://ebible.org/Scriptures/twiasante_usfm.zip"

const OSIS_BOOK_NAMES: Record<string, string> = {
  GEN: "Genesis",
  EXO: "Exodus",
  LEV: "Leviticus",
  NUM: "Numbers",
  DEU: "Deuteronomy",
  JOS: "Joshua",
  JDG: "Judges",
  RUT: "Ruth",
  "1SA": "1 Samuel",
  "2SA": "2 Samuel",
  "1KI": "1 Kings",
  "2KI": "2 Kings",
  "1CH": "1 Chronicles",
  "2CH": "2 Chronicles",
  EZR: "Ezra",
  NEH: "Nehemiah",
  EST: "Esther",
  JOB: "Job",
  PSA: "Psalms",
  PRO: "Proverbs",
  ECC: "Ecclesiastes",
  SNG: "Song of Solomon",
  ISA: "Isaiah",
  JER: "Jeremiah",
  LAM: "Lamentations",
  EZK: "Ezekiel",
  DAN: "Daniel",
  HOS: "Hosea",
  JOL: "Joel",
  AMO: "Amos",
  OBA: "Obadiah",
  JON: "Jonah",
  MIC: "Micah",
  NAM: "Nahum",
  HAB: "Habakkuk",
  ZEP: "Zephaniah",
  HAG: "Haggai",
  ZEC: "Zechariah",
  MAL: "Malachi",
  MAT: "Matthew",
  MRK: "Mark",
  LUK: "Luke",
  JHN: "John",
  ACT: "Acts",
  ROM: "Romans",
  "1CO": "1 Corinthians",
  "2CO": "2 Corinthians",
  GAL: "Galatians",
  EPH: "Ephesians",
  PHP: "Philippians",
  COL: "Colossians",
  "1TH": "1 Thessalonians",
  "2TH": "2 Thessalonians",
  "1TI": "1 Timothy",
  "2TI": "2 Timothy",
  TIT: "Titus",
  PHM: "Philemon",
  HEB: "Hebrews",
  JAS: "James",
  "1PE": "1 Peter",
  "2PE": "2 Peter",
  "1JN": "1 John",
  "2JN": "2 John",
  "3JN": "3 John",
  JUD: "Jude",
  REV: "Revelation",
}

const CANONICAL_BOOK_ORDER = [
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth",
  "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra",
  "Nehemiah", "Esther", "Job", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon",
  "Isaiah", "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel", "Amos",
  "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah",
  "Malachi", "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians",
  "2 Corinthians", "Galatians", "Ephesians", "Philippians", "Colossians",
  "1 Thessalonians", "2 Thessalonians", "1 Timothy", "2 Timothy", "Titus", "Philemon",
  "Hebrews", "James", "1 Peter", "2 Peter", "1 John", "2 John", "3 John", "Jude",
  "Revelation",
] as const

interface ScrollmapperJSON {
  translation: { name?: string; abbreviation?: string }
  books: Array<{
    name: string
    chapters: Array<{
      chapter: number
      verses: Array<{ verse: number; text: string }>
    }>
  }>
}

function parseUsfm(content: string, fallbackBook: string): ScrollmapperJSON["books"][0] | null {
  let bookName = fallbackBook
  let chapter = 0
  const chapters = new Map<number, Array<{ verse: number; text: string }>>()

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith("\\id ")) {
      const code = line.slice(4).trim().split(/\s+/)[0]?.toUpperCase()
      if (code && OSIS_BOOK_NAMES[code]) {
        bookName = OSIS_BOOK_NAMES[code]
      }
      continue
    }
    if (line.startsWith("\\c ")) {
      chapter = Number.parseInt(line.slice(3).trim(), 10)
      continue
    }
    if (line.startsWith("\\v ")) {
      const rest = line.slice(3).trim()
      const space = rest.indexOf(" ")
      if (space === -1 || chapter < 1) continue
      const verseNum = Number.parseInt(rest.slice(0, space), 10)
      let text = rest.slice(space + 1)
      text = text.replace(/\\[a-z0-9]+(\s\*|\s|$)/gi, " ")
      text = text.replace(/\s+/g, " ").trim()
      if (!Number.isFinite(verseNum) || !text) continue
      if (!chapters.has(chapter)) chapters.set(chapter, [])
      chapters.get(chapter)!.push({ verse: verseNum, text })
    }
  }

  if (chapters.size === 0) return null

  return {
    name: bookName,
    chapters: [...chapters.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ch, verses]) => ({
        chapter: ch,
        verses: verses.sort((a, b) => a.verse - b.verse),
      })),
  }
}

async function main() {
  const force = process.argv.includes("--force")
  if (existsSync(OUT_JSON) && !force) {
    console.log(`  ⏭ ${OUT_JSON} already exists (delete or run with --force)`)
    return
  }

  console.log("\n📥 Downloading Asante Twi USFM from eBible.org...\n")
  const zipPath = join(DATA_DIR, "twiasante_usfm.zip")
  const res = await fetch(TWI_USFM_ZIP)
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  }
  await Bun.write(zipPath, await res.arrayBuffer())

  await rm(STAGING, { recursive: true, force: true })
  await mkdir(STAGING, { recursive: true })

  const proc = Bun.spawn(["unzip", "-o", zipPath, "-d", STAGING], {
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await proc.exited) !== 0) {
    throw new Error("unzip failed — install GnuWin32 UnZip or add unzip to PATH")
  }

  const books: ScrollmapperJSON["books"] = []

  async function walk(dir: string) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(p)
      } else if (/\.usfm$/i.test(ent.name)) {
        const text = await Bun.file(p).text()
        const guess = ent.name.replace(/\d+/g, "").slice(0, 3).toUpperCase()
        const parsed = parseUsfm(text, guess)
        if (parsed) books.push(parsed)
      }
    }
  }
  await walk(STAGING)

  if (books.length < 60) {
    throw new Error(`Expected ~66 USFM books, parsed ${books.length}`)
  }

  books.sort(
    (a, b) =>
      CANONICAL_BOOK_ORDER.indexOf(a.name as (typeof CANONICAL_BOOK_ORDER)[number]) -
      CANONICAL_BOOK_ORDER.indexOf(b.name as (typeof CANONICAL_BOOK_ORDER)[number])
  )

  const payload: ScrollmapperJSON = {
    translation: {
      name: "Asante Twi Nkwa Asɛm (eBible.org, dialect: Asante)",
      abbreviation: "TWI",
    },
    books,
  }

  await mkdir(SOURCES_DIR, { recursive: true })
  await Bun.write(OUT_JSON, JSON.stringify(payload, null, 2))
  console.log(`\n✅ Wrote ${OUT_JSON} (${books.length} books)`)
  console.log("   Next: bun run build:bible\n")
}

main().catch((e) => {
  console.error("❌", e)
  process.exit(1)
})
