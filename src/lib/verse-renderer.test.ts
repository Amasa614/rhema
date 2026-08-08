import { describe, expect, it } from "vitest"
import { wrapText } from "./verse-renderer"

function mockCtx(charWidth = 8): CanvasRenderingContext2D {
  return {
    measureText: (text: string) => ({ width: text.length * charWidth }),
  } as CanvasRenderingContext2D
}

describe("wrapText", () => {
  it("honors explicit line breaks before word wrapping", () => {
    const lines = wrapText(
      mockCtx(),
      "Gyataburuwaa bɛdi hia\nNanso nnepa biara nhia",
      10_000
    )

    expect(lines).toEqual([
      "Gyataburuwaa bɛdi hia",
      "Nanso nnepa biara nhia",
    ])
  })
})
