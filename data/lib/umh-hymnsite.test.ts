import { describe, expect, it } from "vitest"
import { parseUmhCatalogFromText } from "./umh-hymnsite"
import { normalizeHymnTitleKey, scoreCatalogTitleMatch } from "./methodist-umh-match"

describe("parseUmhCatalogFromText", () => {
  it("parses hymnsite-style lines", () => {
    const text = `
- 384 Love Divine, All Loves Excelling
- 700 Abide with Me
- 057 O For a Thousand Tongues to Sing
`
    const entries = parseUmhCatalogFromText(text)
    expect(entries).toEqual([
      { number: 384, title: "Love Divine, All Loves Excelling" },
      { number: 700, title: "Abide with Me" },
      { number: 57, title: "O For a Thousand Tongues to Sing" },
    ])
  })

  it("parses hymnsite HTML list items", () => {
    const html = `<li><a href="/lyrics/umh700.sht">700 Abide with Me</a>`
    expect(parseUmhCatalogFromText(html)).toEqual([{ number: 700, title: "Abide with Me" }])
  })
})

describe("scoreCatalogTitleMatch", () => {
  it("scores exact alias matches highly", () => {
    const score = scoreCatalogTitleMatch("Love Divine, All Loves Excelling", {
      title: "Breathing after Holiness",
      alsoKnownAs: ["Love Divine, All Loves Excelling"],
    })
    expect(score).toBeGreaterThanOrEqual(90)
  })

  it("normalizes parenthetical variants", () => {
    const key = normalizeHymnTitleKey("All Hail the Power of Jesus' Name (Ellor)")
    expect(key).toBe("all hail the power of jesus name")
  })
})
