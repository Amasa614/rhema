/// <reference types="bun-types" />

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { normalizeHymnText } from "../../src/lib/hymn-text"
import { deriveAlsoKnownAs } from "./hymn-aliases"

export const SOURCE_URL =
  "https://raw.githubusercontent.com/OpenChristianData/open-christian-data/main/data/hymns/hymnary-pd/collection.json"

export const ATTRIBUTION =
  "Public-domain hymn texts provided by Hymnary.org (Calvin University) via Open Christian Data (CC0-1.0). https://hymnary.org"

export type BundledHymnTradition = "methodist" | "catholic" | "presbyterian" | "classic"

export interface SourceHymn {
  entry_id: string
  title: string
  author: string | null
  stanzas: string[]
  language: string
  hymnal_title: string | null
  hymnal_year: number | null
}

interface SourceCollection {
  data: SourceHymn[]
}

export interface BundledHymnRecord {
  id: string
  number: number
  title: string
  author: string | null
  stanzas: string[]
  sourceHymnal: string | null
  sourceYear: number | null
  traditions: BundledHymnTradition[]
  alsoKnownAs?: string[]
}

const METHODIST_PATTERN = /\b(?:methodist|wesleyan|wesley)\b/i
const CATHOLIC_PATTERN =
  /\b(?:catholic|roman catholic|missal|breviary|liturg(?:y|ical)|eucharist|adoration|mari(?:an|ology)|holy communion|st\.?\s*basil|st\.?\s*gregory)\b/i
const PRESBYTERIAN_PATTERN =
  /\b(?:presbyterian|reformed|psalter|westminster|pcusa|pc\(usa\)|cumberland|church of scotland|united presbyterian)\b/i

/** Well-known titles often used in Catholic worship (public-domain texts only). */
const CATHOLIC_POPULAR_TITLE = [
  "holy god, we praise",
  "panis angelicus",
  "faith of our fathers",
  "immaculate mary",
  "salve regina",
  "adoro te",
  "humbly i adore",
  "soul of my savior",
  "anima christi",
  "hail holy queen",
  "bring flowers of the rarest",
  "o sacrament most holy",
  "sweet sacrament",
]

/** Well-known titles common in Presbyterian / Reformed worship. */
const PRESBYTERIAN_POPULAR_TITLE = [
  "mighty fortress",
  "old hundredth",
  "all people that on earth",
  "joyful, joyful",
  "be thou my vision",
  "i love thy kingdom",
  "guide me, o thou great",
  "how firm a foundation",
  "church's one foundation",
  "blest be the tie",
  "my faith looks up to thee",
  "nearer, my god, to thee",
]

/** Familiar English worship songs often missing from denomination-specific filters. */
const CLASSIC_TITLE_NEEDLES = [
  "abide with me",
  "it is well with my soul",
  "amazing grace",
  "blessed assurance",
  "rock of ages",
  "what a friend we have in jesus",
  "come thou fount",
  "come, thou fount",
  "holy, holy, holy",
  "holy holy holy",
  "great is thy faithfulness",
  "just as i am",
  "old rugged cross",
  "in the garden",
  "when i survey",
  "be still, my soul",
  "be still my soul",
  "the day thou gavest",
  "now thank we all our god",
  "crown him with many crowns",
  "all hail the power",
  "love divine, all loves excelling",
  "fairest lord jesus",
  "turn your eyes upon jesus",
  "to god be the glory",
  "i need thee every hour",
  "sweet hour of prayer",
  "in christ alone",
  "how great thou art",
  "revive us again",
  "trust and obey",
  "pass me not",
  "softly and tenderly",
  "standing on the promises",
  "leaning on the everlasting arms",
  "shall we gather at the river",
  "whispering hope",
  "my hope is built",
  "onward, christian soldiers",
  "fight the good fight",
  "for the beauty of the earth",
  "all creatures of our god and king",
  "this is my father's world",
  "a mighty fortress",
]

function metaText(hymn: SourceHymn): string {
  return `${hymn.author ?? ""} ${hymn.hymnal_title ?? ""}`
}

function titleMatchesPopular(title: string, needles: string[]): boolean {
  const normalized = normalizeHymnText(title).toLowerCase()
  return needles.some((needle) => normalized.includes(needle))
}

function isEnglishHymn(hymn: SourceHymn): boolean {
  return hymn.language === "en" && hymn.stanzas.length > 0
}

function hymnBody(hymn: SourceHymn): string {
  return normalizeHymnText(
    `${hymn.title}\n${hymn.stanzas[0] ?? ""}`,
  ).toLowerCase()
}

/** Include well-known hymns that are PD in Hymnary but not tagged Methodist/Catholic/Presbyterian. */
export function isClassicWorshipHymn(hymn: SourceHymn): boolean {
  if (!isEnglishHymn(hymn)) return false

  if (titleMatchesPopular(hymn.title, CLASSIC_TITLE_NEEDLES)) return true

  const title = normalizeHymnText(hymn.title).toLowerCase()
  const author = (hymn.author ?? "").toLowerCase()
  const body = hymnBody(hymn)

  if (title.includes("abide with me") || (author.includes("lyte") && body.includes("abide with me"))) {
    return true
  }
  if (
    title.includes("it is well with my soul") ||
    (author.includes("spafford") && body.includes("peace, like a river"))
  ) {
    return true
  }
  if (
    title.includes("amazing grace") ||
    (author.includes("newton") && body.includes("amazing grace"))
  ) {
    return true
  }
  if (body.includes("love divine, all love excelling")) return true

  return false
}

export function traditionsForHymn(hymn: SourceHymn): BundledHymnTradition[] {
  if (!isEnglishHymn(hymn)) return []

  const traditions: BundledHymnTradition[] = []
  const meta = metaText(hymn)
  const title = hymn.title

  if (METHODIST_PATTERN.test(meta)) traditions.push("methodist")
  if (CATHOLIC_PATTERN.test(meta) || titleMatchesPopular(title, CATHOLIC_POPULAR_TITLE)) {
    traditions.push("catholic")
  }
  if (
    PRESBYTERIAN_PATTERN.test(meta) ||
    titleMatchesPopular(title, PRESBYTERIAN_POPULAR_TITLE)
  ) {
    traditions.push("presbyterian")
  }
  if (isClassicWorshipHymn(hymn)) traditions.push("classic")

  return traditions
}

function cleanStanza(stanza: string): string {
  return normalizeHymnText(stanza.replace(/^\s*\d+[.)]?\s*/, ""))
}

function toRecord(hymn: SourceHymn, traditions: BundledHymnTradition[]): BundledHymnRecord {
  const alsoKnownAs = deriveAlsoKnownAs(hymn)
  return {
    id: hymn.entry_id,
    title: normalizeHymnText(hymn.title),
    author: hymn.author ? normalizeHymnText(hymn.author) : null,
    stanzas: hymn.stanzas.map(cleanStanza).filter(Boolean),
    sourceHymnal: hymn.hymnal_title ? normalizeHymnText(hymn.hymnal_title) : null,
    sourceYear: hymn.hymnal_year,
    number: 0,
    traditions,
    ...(alsoKnownAs.length > 0 ? { alsoKnownAs } : {}),
  }
}

export async function fetchHymnaryCollection(): Promise<SourceHymn[]> {
  console.log("Downloading the Hymnary public-domain collection...")
  const response = await fetch(SOURCE_URL)
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`)
  }
  const collection = (await response.json()) as SourceCollection
  return collection.data
}

/** Merge hymns that appear in multiple tradition filters. */
export function buildBundledHymns(source: SourceHymn[]): BundledHymnRecord[] {
  const byId = new Map<string, BundledHymnRecord>()

  for (const hymn of source) {
    const traditions = traditionsForHymn(hymn)
    if (traditions.length === 0) continue

    const record = toRecord(hymn, traditions)
    if (record.stanzas.length === 0) continue

    const existing = byId.get(record.id)
    if (!existing) {
      byId.set(record.id, record)
      continue
    }

    const merged = new Set([...existing.traditions, ...record.traditions])
    byId.set(record.id, { ...existing, traditions: [...merged] })
  }

  return [...byId.values()]
    .toSorted((a, b) => a.title.localeCompare(b.title))
    .map((hymn, index) => ({ ...hymn, number: index + 1 }))
}

export function hymnsForTradition(
  hymns: BundledHymnRecord[],
  tradition: BundledHymnTradition,
): BundledHymnRecord[] {
  return hymns
    .filter((hymn) => hymn.traditions.includes(tradition))
    .toSorted((a, b) => a.title.localeCompare(b.title))
    .map((hymn, index) => ({ ...hymn, number: index + 1 }))
}

export async function writeHymnCollectionFile(
  outputPath: string,
  hymns: BundledHymnRecord[],
  label: string,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        attribution: ATTRIBUTION,
        source: SOURCE_URL,
        generatedAt: new Date().toISOString(),
        label,
        hymns,
      },
      null,
      2,
    ),
  )
  console.log(`Saved ${hymns.length} hymns → ${outputPath}`)
}

export const PUBLIC_DATA_DIR = join(import.meta.dir, "..", "..", "public", "data")
