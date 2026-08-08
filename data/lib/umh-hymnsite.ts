/// <reference types="bun-types" />

/** United Methodist Hymnal index (numbers + titles only) from hymnsite.com */
export const UMH_HYMNSITE_URL = "https://www.hymnsite.com/123.sht"

export interface UmhCatalogEntry {
  number: number
  title: string
}

const LINE_PATTERN = /^\s*[-*]\s*(\d{1,3})\s+(.+?)\s*$/gm
const HTML_LI_PATTERN =
  /<li>\s*<a[^>]*>\s*(\d{1,3})\s+(.+?)<\/a>/gi

/** Parse hymnsite.com numerical list (HTML or markdown). */
export function parseUmhCatalogFromText(body: string): UmhCatalogEntry[] {
  const entries: UmhCatalogEntry[] = []
  const seen = new Set<number>()

  for (const match of body.matchAll(HTML_LI_PATTERN)) {
    const number = Number.parseInt(match[1] ?? "", 10)
    const title = (match[2] ?? "").replace(/\s+/g, " ").trim()
    if (!Number.isFinite(number) || title.length === 0 || seen.has(number)) continue
    seen.add(number)
    entries.push({ number, title })
  }

  if (entries.length >= 100) {
    return entries
  }

  for (const match of body.matchAll(LINE_PATTERN)) {
    const number = Number.parseInt(match[1] ?? "", 10)
    const title = (match[2] ?? "").trim()
    if (!Number.isFinite(number) || title.length === 0 || seen.has(number)) continue
    seen.add(number)
    entries.push({ number, title })
  }

  return entries
}

export async function fetchUmhCatalog(): Promise<UmhCatalogEntry[]> {
  console.log(`Fetching UMH catalog from ${UMH_HYMNSITE_URL}…`)
  const response = await fetch(UMH_HYMNSITE_URL, {
    headers: { "User-Agent": "Rhema hymn build script (OpenChristianData companion)" },
  })
  if (!response.ok) {
    throw new Error(`UMH catalog download failed: ${response.status} ${response.statusText}`)
  }
  const body = await response.text()
  const entries = parseUmhCatalogFromText(body)
  if (entries.length < 100) {
    throw new Error(
      `UMH catalog parse yielded only ${entries.length} entries — page format may have changed`,
    )
  }
  console.log(`  Parsed ${entries.length} UMH catalog entries`)
  return entries
}
