const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  rdquo: "”",
  rsquo: "’",
}

const ENTITY_PATTERN = /&(#x[\da-f]+|#\d+|[a-z]+);/gi
const STANZA_HEADING =
  /^\s*(?:(?:verse|stanza)\s+\d+|chorus|refrain|bridge|\d+[.)])\s*:?\s*(.*)$/i

export function decodeHtmlEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (entity, code: string) => {
    if (code[0] !== "#") return NAMED_ENTITIES[code.toLowerCase()] ?? entity

    const isHex = code[1]?.toLowerCase() === "x"
    const point = Number.parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10)
    if (!Number.isFinite(point) || point < 0 || point > 0x10ffff) return entity
    return String.fromCodePoint(point)
  })
}

export function normalizeHymnText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Parse pasted lyrics separated by blank lines or Verse/Chorus headings. */
export function parseHymnStanzas(value: string): string[] {
  const lines = normalizeHymnText(value).split("\n")
  const stanzas: string[] = []
  let current: string[] = []

  const flush = () => {
    const stanza = current.join("\n").trim()
    if (stanza) stanzas.push(stanza)
    current = []
  }

  for (const line of lines) {
    if (!line) {
      flush()
      continue
    }

    const heading = line.match(STANZA_HEADING)
    if (heading) {
      flush()
      if (heading[1]) current.push(heading[1])
      continue
    }
    current.push(line)
  }
  flush()

  return stanzas
}

/** Preserve line breaks for projection; only collapse spaces/tabs within each line. */
export function formatProjectionLyrics(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim()
}
