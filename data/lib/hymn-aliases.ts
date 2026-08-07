import { normalizeHymnText } from "../../src/lib/hymn-text"

/** Hymnary entry_id → names used in church and on hymnary.org topic pages. */
export const KNOWN_HYMN_ALIASES: Record<string, string[]> = {
  "breathing-after-holiness": ["Love Divine, All Loves Excelling"],
  "abide-with-me-fast-falls-the-evenitde": ["Abide with Me"],
  "it-is-well-with-my-soul": ["It Is Well with My Soul"],
}

const OPENING_LINE_ALIASES: Array<{ pattern: RegExp; names: string[] }> = [
  {
    pattern: /love divine,\s*all love excelling/i,
    names: ["Love Divine, All Loves Excelling"],
  },
  {
    pattern: /when peace,\s*like a river/i,
    names: ["It Is Well with My Soul"],
  },
  {
    pattern: /abide with me!\s*fast falls the eventide/i,
    names: ["Abide with Me"],
  },
  {
    pattern: /^amazing grace!?(\s|,|$)/i,
    names: ["Amazing Grace"],
  },
  {
    pattern: /joyful, joyful, we adore thee/i,
    names: ["Joyful, Joyful, We Adore Thee"],
  },
  {
    pattern: /come, thou fount of every blessing/i,
    names: ["Come, Thou Fount of Every Blessing"],
  },
]

export function deriveAlsoKnownAs(hymn: {
  entry_id: string
  title: string
  stanzas: string[]
}): string[] {
  const names = new Set<string>(KNOWN_HYMN_ALIASES[hymn.entry_id] ?? [])
  const body = normalizeHymnText(hymn.stanzas.join("\n"))

  for (const { pattern, names: aliasNames } of OPENING_LINE_ALIASES) {
    if (pattern.test(body)) {
      for (const name of aliasNames) names.add(name)
    }
  }

  const canonical = normalizeHymnText(hymn.title)
  return [...names].filter((name) => normalizeHymnText(name) !== canonical)
}
