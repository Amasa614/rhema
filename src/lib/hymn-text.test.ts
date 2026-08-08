import { describe, expect, it } from "vitest"
import {
  decodeHtmlEntities,
  formatProjectionLyrics,
  normalizeHymnText,
  parseHymnStanzas,
} from "./hymn-text"

describe("hymn text parsing", () => {
  it("decodes numeric and named HTML entities", () => {
    expect(decodeHtmlEntities("other&#8217;s &amp; Christ&apos;s")).toBe(
      "other’s & Christ's",
    )
  })

  it("normalizes indentation without removing line breaks", () => {
    expect(normalizeHymnText("  First line\r\n    Second line  ")).toBe(
      "First line\nSecond line",
    )
  })

  it("keeps projection line breaks while trimming each line", () => {
    expect(
      formatProjectionLyrics("  Line one  \n  Line two  ")
    ).toBe("Line one\nLine two")
  })

  it("splits pasted lyrics by headings and blank lines", () => {
    expect(
      parseHymnStanzas(
        "Verse 1\nFirst line\nSecond line\n\nChorus\nSing again\n\n2. Final line",
      ),
    ).toEqual([
      "First line\nSecond line",
      "Sing again",
      "Final line",
    ])
  })
})
