export type HymnTradition = "methodist" | "catholic" | "presbyterian" | "classic" | "custom"

export interface Hymn {
  id: string
  number: number
  title: string
  author: string | null
  stanzas: string[]
  sourceHymnal: string | null
  sourceYear: number | null
  /** Which library this entry belongs to (may include multiple for bundled texts). */
  traditions: HymnTradition[]
  /** Common worship name when Hymnary uses a different catalog title. */
  alsoKnownAs?: string[]
  isCustom?: boolean
}

export interface HymnCollection {
  attribution: string
  source: string
  generatedAt: string
  hymns: Hymn[]
}
