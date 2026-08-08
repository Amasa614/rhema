import { describe, expect, it } from "vitest"
import { buildNoteProjectionSlides } from "./note-slides"

describe("buildNoteProjectionSlides", () => {
  it("uses markdown headings as projection references", () => {
    const slides = buildNoteProjectionSlides(
      "## Central Theme\nBreakthrough requires hunger and persistent seeking."
    )

    expect(slides).toEqual([
      {
        heading: "Central Theme",
        text: "Breakthrough requires hunger and persistent seeking.",
      },
    ])
  })

  it("splits long sermon outlines into readable slides", () => {
    const body = `## Sermon Outline
1. The danger of comfort
- Genesis 27:40 cited: a promise of breaking yokes comes after restlessness and pressing.
- Comfort, regular provision, and familiar habits can prevent believers from pressing into destiny.
- The law of consistency and hunger requires persistent pursuit and wholehearted dependence on God.`

    const slides = buildNoteProjectionSlides(body)

    expect(slides.length).toBeGreaterThan(1)
    expect(slides.every((slide) => slide.text.length <= 160)).toBe(true)
    expect(slides.every((slide) => slide.heading === "Sermon Outline")).toBe(
      true
    )
    expect(slides.some((slide) => slide.text.includes("##"))).toBe(false)
  })

  it("keeps blank lines as intentional slide boundaries", () => {
    const slides = buildNoteProjectionSlides(
      "Opening announcement.\n\nClosing announcement."
    )

    expect(slides.map((slide) => slide.text)).toEqual([
      "Opening announcement.",
      "Closing announcement.",
    ])
  })
})
