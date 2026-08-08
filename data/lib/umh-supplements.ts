/// <reference types="bun-types" />

import { normalizeHymnText } from "../../src/lib/hymn-text"
import type { BundledHymnRecord } from "./hymnary-download"

/**
 * UMH catalog titles that failed fuzzy match but have a known Hymnary PD entry_id.
 * @see https://www.hymnsite.com/123.sht
 */
export const UMH_HYMNARY_OVERRIDES: Record<number, string> = {
  57: "christ-worthy-of-all-praise",
  376: "agnus-dei-qui-tollis-peccata-mundi",
  529: "exceeding-great-and-precious-promises",
  573: "publish-glad-tidings",
  622: "happy-strains",
}

const PLACEHOLDER_STANZA =
  "Full lyrics for this hymnal entry are not bundled (copyright). You can paste your church’s licensed text under Settings → Songs & Hymns."

interface ManualUmhSpec {
  number: number
  catalogTitle: string
  author: string | null
  stanzas: string[]
  placeholder?: boolean
}

/** PD English texts or placeholders for UMH entries missing from Hymnary PD. */
const MANUAL_UMH: ManualUmhSpec[] = [
  {
    number: 115,
    catalogTitle: "How Like a Gentle Spirit",
    author: "Gerhard Tersteegen; tr. Jane Borthwick",
    stanzas: [
      "How like a gentle spirit, deep within our being, thou dost dwell!",
      "Purity and love and gladness all thy presence breathe around.",
      "O thou soul-transforming Spirit, sanctify us, we implore;",
      "Make our hearts thy holy temple, thine for evermore.",
    ],
  },
  {
    number: 229,
    catalogTitle: "Infant Holy, Infant Lowly",
    author: "Polish carol; tr. Edith Margaret Clarkson",
    stanzas: [
      "Infant holy, infant lowly, for his bed a cattle stall;",
      "Oxen lowing, little knowing, Christ the babe is Lord of all.",
      "Swift are winged angels singing, now the bells of heaven ring;",
      "Tell abroad his righteous bringing, Christ the babe is Lord of all.",
      "Flocks were sleeping, shepherds keeping vigil till the morning new;",
      "Saw the glory, heard the story, tidings of a world come true.",
      "Thus rejoicing, free from sorrow, praises voicing, greet the morrow:",
      "Christ the babe was born for you, Christ the babe was born for you.",
    ],
  },
  {
    number: 304,
    catalogTitle: "Easter People, Raise Your Voices",
    author: "Brian Wren",
    placeholder: true,
    stanzas: [PLACEHOLDER_STANZA],
  },
  {
    number: 439,
    catalogTitle: "We Utter Our Cry",
    author: "Fred Kaan",
    placeholder: true,
    stanzas: [PLACEHOLDER_STANZA],
  },
  {
    number: 517,
    catalogTitle: "By Gracious Powers",
    author: "Dietrich Bonhoeffer; tr. Fred Pratt Green",
    placeholder: true,
    stanzas: [PLACEHOLDER_STANZA],
  },
  {
    number: 530,
    catalogTitle: "Are Ye Able",
    author: "Earl Marlatt",
    stanzas: [
      "“Are ye able,” said the Master, “to be crucified with me?”\n“Yea,” the sturdy dreamers answered, “to the death we follow thee.”\nLord, we are able. Our spirits are thine.\nRemagnet our lives with thy word divine.",
      "Are ye able to remember, when a thief lifts up his eyes,\nThat his pardoned soul is worthy of a place in paradise?",
      "Are ye able when the shadows close around you with the sod,\nTo believe that spirit triumphs, to commend your soul to God?",
      "Are ye able? Still the Master whispers down eternity,\nAnd heroic spirits answer, now as then in Galilee.",
    ],
  },
  {
    number: 611,
    catalogTitle: "Child of Blessing, Child of Promise",
    author: "Natalie Sleeth",
    placeholder: true,
    stanzas: [PLACEHOLDER_STANZA],
  },
]

const manualByNumber = new Map(MANUAL_UMH.map((entry) => [entry.number, entry]))

export function manualUmhSupplement(number: number): ManualUmhSpec | undefined {
  return manualByNumber.get(number)
}

export function recordFromManualSpec(spec: ManualUmhSpec): BundledHymnRecord {
  const title = normalizeHymnText(spec.catalogTitle)

  return {
    id: `umh-manual-${spec.number}`,
    number: spec.number,
    title,
    author: spec.author ? normalizeHymnText(spec.author) : null,
    stanzas: spec.stanzas.map((s) => normalizeHymnText(s)),
    sourceHymnal: spec.placeholder
      ? "United Methodist Hymnal (lyrics not bundled)"
      : "United Methodist Hymnal supplement (public domain)",
    sourceYear: null,
    traditions: ["methodist"],
  }
}

export function allManualUmhRecords(): BundledHymnRecord[] {
  return MANUAL_UMH.map(recordFromManualSpec)
}
