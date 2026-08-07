import type { Hymn } from "@/types/hymn"
import { hymnDisplayTitle, hymnSearchBlob } from "@/lib/hymn-display"

/** Match query tokens with simple plural folding (loves → love). */
export function hymnQueryTokenMatches(haystack: string, word: string): boolean {
  if (haystack.includes(word)) return true
  if (word.length > 3 && word.endsWith("s") && haystack.includes(word.slice(0, -1))) {
    return true
  }
  if (word.length > 4 && word.endsWith("es") && haystack.includes(word.slice(0, -2))) {
    return true
  }
  return false
}

/** Higher score = better match for worship search (title and common names first). */
export function scoreHymnSearch(hymn: Hymn, words: string[]): number {
  if (words.length === 0) return 0

  const title = hymnDisplayTitle(hymn).toLowerCase()
  const catalogTitle = hymn.title.toLowerCase()
  const author = (hymn.author ?? "").toLowerCase()
  const phrase = words.join(" ")

  let score = 0
  if (title === phrase || catalogTitle === phrase) score += 200
  else if (title.includes(phrase) || catalogTitle.includes(phrase)) score += 120
  if (title.startsWith(words[0] ?? "") || catalogTitle.startsWith(words[0] ?? "")) {
    score += 40
  }

  for (const word of words) {
    if (hymnQueryTokenMatches(title, word) || hymnQueryTokenMatches(catalogTitle, word)) {
      score += 25
    } else if (hymnQueryTokenMatches(author, word)) score += 12
    else score += 1
  }

  return score
}

export function filterAndRankHymns(
  hymns: Hymn[],
  query: string,
  limit: number,
): Hymn[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return hymns.slice(0, limit)

  const matches = hymns.filter((hymn) => {
    const searchable = hymnSearchBlob(hymn)
    return words.every((word) => hymnQueryTokenMatches(searchable, word))
  })

  return matches
    .slice()
    .sort((a, b) => scoreHymnSearch(b, words) - scoreHymnSearch(a, words))
    .slice(0, limit)
}
