import { describe, expect, it } from "vitest"
import { filterAndRankHymns } from "./hymn-search-rank"
import type { Hymn } from "@/types/hymn"

const sample: Hymn[] = [
  {
    id: "1",
    number: 1,
    title: "Breathing after Holiness",
    alsoKnownAs: ["Love Divine, All Loves Excelling"],
    author: "Wesley, Charles",
    stanzas: ["Love divine, all love excelling, Joy of heaven to earth come down!"],
    sourceHymnal: null,
    sourceYear: null,
    traditions: ["methodist", "classic"],
  },
  {
    id: "2",
    number: 2,
    title: "It is well with my soul",
    author: "Spafford",
    stanzas: ["When peace, like a river"],
    sourceHymnal: null,
    sourceYear: null,
    traditions: ["classic"],
  },
  {
    id: "3",
    number: 3,
    title: "Homeland of the Soul",
    author: null,
    stanzas: ["It is well with my soul somewhere"],
    sourceHymnal: null,
    sourceYear: null,
    traditions: ["classic"],
  },
  {
    id: "4",
    number: 4,
    title: "Abide with me! fast falls the eventide",
    author: "Lyte",
    stanzas: ["Abide with me"],
    sourceHymnal: null,
    sourceYear: null,
    traditions: ["classic"],
  },
]

describe("filterAndRankHymns", () => {
  it("finds Love Divine by common name and plural loves", () => {
    const results = filterAndRankHymns(sample, "love divine all loves excelling", 10)
    expect(results[0]?.alsoKnownAs?.[0]).toBe("Love Divine, All Loves Excelling")
  })

  it("ranks exact title matches first", () => {
    const results = filterAndRankHymns(sample, "it is well with my soul", 10)
    expect(results[0]?.title).toBe("It is well with my soul")
  })

  it("ranks abide with me by title", () => {
    const results = filterAndRankHymns(sample, "abide with me", 10)
    expect(results[0]?.title).toContain("Abide with me")
  })
})
