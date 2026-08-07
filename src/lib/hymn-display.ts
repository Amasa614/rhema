import type { Hymn } from "@/types/hymn"

/** Name congregations expect (Hymnary often uses a different catalog title). */
export function hymnDisplayTitle(hymn: Hymn): string {
  return hymn.alsoKnownAs?.[0] ?? hymn.title
}

export function hymnSearchBlob(hymn: Hymn): string {
  const parts = [
    String(hymn.number),
    hymn.title,
    ...(hymn.alsoKnownAs ?? []),
    hymn.author ?? "",
    ...hymn.stanzas,
  ]
  return parts.join(" ").toLowerCase()
}
