/// <reference types="bun-types" />

import { normalizeHymnText } from "../../src/lib/hymn-text"
import { deriveAlsoKnownAs } from "./hymn-aliases"
import type { BundledHymnRecord, SourceHymn } from "./hymnary-download"
import type { UmhCatalogEntry } from "./umh-hymnsite"
import {
  UMH_HYMNARY_OVERRIDES,
  manualUmhSupplement,
  recordFromManualSpec,
} from "./umh-supplements"

/** Strip variant suffixes like "(Ellor)" or "(3/4 time)" for matching. */
export function normalizeHymnTitleKey(title: string): string {
  return normalizeHymnText(title)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokens(key: string): string[] {
  return key.split(" ").filter((t) => t.length > 1)
}

function tokenOverlapScore(a: string, b: string): number {
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) {
    if (tb.has(t)) shared += 1
  }
  return shared / Math.max(ta.size, tb.size)
}

/** Score how well a catalog title matches a hymn (0–100). */
export function scoreCatalogTitleMatch(
  catalogTitle: string,
  hymn: { title: string; alsoKnownAs: string[] },
): number {
  const catalogKey = normalizeHymnTitleKey(catalogTitle)
  const titleKey = normalizeHymnTitleKey(hymn.title)

  if (catalogKey === titleKey) return 100
  if (catalogKey.startsWith(titleKey) || titleKey.startsWith(catalogKey)) return 92

  for (const alias of hymn.alsoKnownAs) {
    const aliasKey = normalizeHymnTitleKey(alias)
    if (catalogKey === aliasKey) return 98
    if (catalogKey.startsWith(aliasKey) || aliasKey.startsWith(catalogKey)) return 90
  }

  if (catalogKey.includes(titleKey) || titleKey.includes(catalogKey)) {
    return 78 + tokenOverlapScore(catalogKey, titleKey) * 12
  }

  for (const alias of hymn.alsoKnownAs) {
    const aliasKey = normalizeHymnTitleKey(alias)
    if (catalogKey.includes(aliasKey) || aliasKey.includes(catalogKey)) {
      return 75 + tokenOverlapScore(catalogKey, aliasKey) * 15
    }
  }

  const overlap = tokenOverlapScore(catalogKey, titleKey)
  if (overlap >= 0.55) return 60 + overlap * 30

  return overlap * 50
}

const MATCH_THRESHOLD = 72

function isEnglishSource(hymn: SourceHymn): boolean {
  return hymn.language === "en" && hymn.stanzas.length > 0
}

function sourceToMatchCandidate(hymn: SourceHymn): {
  source: SourceHymn
  title: string
  alsoKnownAs: string[]
} {
  const alsoKnownAs = deriveAlsoKnownAs(hymn)
  return {
    source: hymn,
    title: normalizeHymnText(hymn.title),
    alsoKnownAs,
  }
}

function findBestSourceMatch(
  catalogTitle: string,
  candidates: ReturnType<typeof sourceToMatchCandidate>[],
): { candidate: (typeof candidates)[number]; score: number } | null {
  let best: { candidate: (typeof candidates)[number]; score: number } | null = null

  for (const candidate of candidates) {
    const score = scoreCatalogTitleMatch(catalogTitle, candidate)
    if (score < MATCH_THRESHOLD) continue
    if (!best || score > best.score) {
      best = { candidate, score }
    }
  }

  return best
}

function cleanStanza(stanza: string): string {
  return normalizeHymnText(stanza.replace(/^\s*\d+[.)]?\s*/, ""))
}

function recordFromSource(
  hymn: SourceHymn,
  number: number,
  catalogTitle: string,
): BundledHymnRecord {
  const alsoKnownAs = deriveAlsoKnownAs(hymn)
  const catalogNorm = normalizeHymnText(catalogTitle)
  const names = new Set(alsoKnownAs)
  if (normalizeHymnTitleKey(catalogNorm) !== normalizeHymnTitleKey(hymn.title)) {
    names.add(catalogNorm)
  }

  return {
    id: `${hymn.entry_id}-umh-${number}`,
    number,
    title: normalizeHymnText(hymn.title),
    author: hymn.author ? normalizeHymnText(hymn.author) : null,
    stanzas: hymn.stanzas.map(cleanStanza).filter(Boolean),
    sourceHymnal: hymn.hymnal_title ? normalizeHymnText(hymn.hymnal_title) : null,
    sourceYear: hymn.hymnal_year,
    traditions: ["methodist"],
    ...(names.size > 0 ? { alsoKnownAs: [...names] } : {}),
  }
}

export interface UmhMatchReport {
  hymns: BundledHymnRecord[]
  matched: number
  unmatched: UmhCatalogEntry[]
}

function recordFromOverride(
  hymn: SourceHymn,
  number: number,
  catalogTitle: string,
): BundledHymnRecord {
  return recordFromSource(hymn, number, catalogTitle)
}

/** Build Methodist library keyed to UMH numbers using Hymnary PD texts. */
export function buildMethodistUmhHymns(
  source: SourceHymn[],
  catalog: UmhCatalogEntry[],
): UmhMatchReport {
  const sourceById = new Map(source.map((h) => [h.entry_id, h]))
  const candidates = source.filter(isEnglishSource).map(sourceToMatchCandidate)
  const hymns: BundledHymnRecord[] = []
  const unmatched: UmhCatalogEntry[] = []

  for (const entry of catalog) {
    if (/^(Jesus Es Mi|Pues Si Vivimos)/i.test(entry.title)) {
      continue
    }

    let record: BundledHymnRecord | null = null

    const overrideId = UMH_HYMNARY_OVERRIDES[entry.number]
    if (overrideId) {
      const hymn = sourceById.get(overrideId)
      if (hymn && isEnglishSource(hymn)) {
        record = recordFromOverride(hymn, entry.number, entry.title)
      }
    }

    if (!record) {
      const match = findBestSourceMatch(entry.title, candidates)
      if (match) {
        record = recordFromSource(match.candidate.source, entry.number, entry.title)
      }
    }

    if (!record) {
      const manual = manualUmhSupplement(entry.number)
      if (manual) {
        record = recordFromManualSpec(manual)
      }
    }

    if (!record || record.stanzas.length === 0) {
      unmatched.push(entry)
      continue
    }
    hymns.push(record)
  }

  hymns.sort((a, b) => a.number - b.number)

  return {
    hymns,
    matched: hymns.length,
    unmatched,
  }
}

/** Ensure UMH-matched hymns are in the merged `all` list with methodist tradition. */
export function mergeUmhIntoAll(
  all: BundledHymnRecord[],
  umhHymns: BundledHymnRecord[],
): BundledHymnRecord[] {
  const byId = new Map(all.map((h) => [h.id, { ...h }]))

  for (const umh of umhHymns) {
    const baseId = umh.id.replace(/-umh-\d+$/, "")
    const existing = byId.get(baseId)
    if (existing) {
      const traditions = new Set([...existing.traditions, "methodist"])
      const aliases = new Set([...(existing.alsoKnownAs ?? []), ...(umh.alsoKnownAs ?? [])])
      byId.set(baseId, {
        ...existing,
        traditions: [...traditions],
        ...(aliases.size > 0 ? { alsoKnownAs: [...aliases] } : {}),
      })
    } else {
      byId.set(baseId, { ...umh, id: baseId })
    }
  }

  return [...byId.values()]
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((hymn, index) => ({ ...hymn, number: index + 1 }))
}
