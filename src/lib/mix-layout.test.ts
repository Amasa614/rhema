import { describe, expect, it } from "vitest"
import { BUILTIN_THEMES } from "./builtin-themes"
import {
  MIX_CAMERA_ASPECT,
  mixContainFit,
  mixCoverFit,
  mixInsetRect,
  mixSlideTheme,
  mixSplitLayout,
} from "./mix-layout"

describe("mixSplitLayout", () => {
  it("places a portrait camera left of a wider slide pane", () => {
    const layout = mixSplitLayout(1920, 1080)
    expect(layout.camera.x).toBeLessThan(layout.slide.x)
    expect(layout.camera.y).toBe(layout.slide.y)
    expect(layout.camera.height).toBe(layout.slide.height)
    expect(layout.slide.width).toBeGreaterThan(layout.camera.width)
    expect(layout.camera.width / layout.camera.height).toBeCloseTo(
      MIX_CAMERA_ASPECT,
      2,
    )
    expect(layout.slide.x + layout.slide.width).toBeLessThanOrEqual(1920)
    expect(layout.camera.y + layout.camera.height).toBeLessThanOrEqual(1080)
  })

  it("leaves a gutter so the theme background shows around the panes", () => {
    const layout = mixSplitLayout(1920, 1080)
    expect(layout.camera.x).toBeGreaterThan(20)
    expect(layout.slide.x).toBeGreaterThan(
      layout.camera.x + layout.camera.width + 10,
    )
  })
})

describe("mixContainFit", () => {
  it("keeps the full 16:9 slide inside the pane", () => {
    const dest = { x: 600, y: 40, width: 1240, height: 1000 }
    const fit = mixContainFit(1920, 1080, dest)
    expect(1920 * fit.scale).toBeLessThanOrEqual(dest.width + 0.5)
    expect(1080 * fit.scale).toBeLessThanOrEqual(dest.height + 0.5)
    expect(fit.offsetX).toBeGreaterThanOrEqual(dest.x - 0.5)
  })
})

describe("mixCoverFit", () => {
  it("covers a shorter-than-16:9 slide pane", () => {
    const dest = { x: 600, y: 40, width: 1240, height: 1000 }
    const fit = mixCoverFit(1920, 1080, dest)
    expect(1920 * fit.scale).toBeGreaterThanOrEqual(dest.width - 0.5)
    expect(1080 * fit.scale).toBeGreaterThanOrEqual(dest.height - 0.5)
    expect(fit.offsetX).toBeLessThanOrEqual(dest.x)
  })
})

describe("mixInsetRect", () => {
  it("shrinks a pane equally on all sides", () => {
    const inset = mixInsetRect(
      { x: 100, y: 40, width: 800, height: 600 },
      40,
    )
    expect(inset).toEqual({ x: 140, y: 80, width: 720, height: 520 })
  })
})

describe("mixSlideTheme", () => {
  it("uses the pane size and a wider text area than the 16:9 theme", () => {
    const dest = { x: 640, y: 30, width: 1240, height: 1020 }
    const theme = BUILTIN_THEMES[0]
    const slide = mixSlideTheme(theme, dest)
    expect(slide.resolution).toEqual({ width: 1240, height: 1020 })
    expect(slide.layout.textAreaWidth).toBeGreaterThan(theme.layout.textAreaWidth)
    expect(slide.layout.padding.left).toBeLessThan(theme.layout.padding.left)
  })
})
