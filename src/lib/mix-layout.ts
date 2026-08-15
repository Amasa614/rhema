import type { BroadcastTheme } from "@/types/broadcast"

export interface MixPanelRect {
  x: number
  y: number
  width: number
  height: number
}

export interface MixSplitLayout {
  camera: MixPanelRect
  slide: MixPanelRect
  radius: number
}

/** Portrait camera pane, matching a typical phone / pulpit crop. */
export const MIX_CAMERA_ASPECT = 9 / 16

export function mixSplitLayout(width: number, height: number): MixSplitLayout {
  const margin = Math.round(height * 0.028)
  const gap = Math.round(width * 0.014)
  const panelH = Math.max(1, height - margin * 2)
  let cameraW = Math.round(panelH * MIX_CAMERA_ASPECT)
  cameraW = Math.min(cameraW, Math.round(width * 0.36))
  const minSlide = Math.round(width * 0.48)
  let slideW = width - margin * 2 - gap - cameraW
  if (slideW < minSlide) {
    cameraW = Math.max(1, width - margin * 2 - gap - minSlide)
    slideW = width - margin * 2 - gap - cameraW
  }
  return {
    camera: { x: margin, y: margin, width: cameraW, height: panelH },
    slide: {
      x: margin + cameraW + gap,
      y: margin,
      width: Math.max(1, slideW),
      height: panelH,
    },
    radius: Math.max(8, Math.round(height * 0.01)),
  }
}

/** Scale a 16:9 slide so the whole frame fits in the pane (no side crop). */
export function mixContainFit(
  srcW: number,
  srcH: number,
  dest: MixPanelRect,
): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.min(dest.width / srcW, dest.height / srcH)
  return {
    scale,
    offsetX: dest.x + (dest.width - srcW * scale) / 2,
    offsetY: dest.y + (dest.height - srcH * scale) / 2,
  }
}

/** Scale a 16:9 slide so it covers the mix slide pane (sides may crop). */
export function mixCoverFit(
  srcW: number,
  srcH: number,
  dest: MixPanelRect,
): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.max(dest.width / srcW, dest.height / srcH)
  return {
    scale,
    offsetX: dest.x + (dest.width - srcW * scale) / 2,
    offsetY: dest.y + (dest.height - srcH * scale) / 2,
  }
}

export function mixInsetRect(rect: MixPanelRect, inset: number): MixPanelRect {
  const pad = Math.max(0, Math.round(inset))
  return {
    x: rect.x + pad,
    y: rect.y + pad,
    width: Math.max(1, rect.width - pad * 2),
    height: Math.max(1, rect.height - pad * 2),
  }
}

export function mixSlideInset(slide: MixPanelRect): number {
  return Math.round(Math.min(slide.width, slide.height) * 0.02)
}

/** Lay the verse out in the slide pane so type can use the full frame. */
export function mixSlideTheme(
  theme: BroadcastTheme,
  dest: MixPanelRect,
): BroadcastTheme {
  const sx = dest.width / theme.resolution.width
  const sy = dest.height / theme.resolution.height
  return {
    ...theme,
    resolution: { width: dest.width, height: dest.height },
    layout: {
      ...theme.layout,
      offsetX: theme.layout.offsetX * sx,
      offsetY: theme.layout.offsetY * sy,
      padding: {
        top: Math.round(theme.layout.padding.top * sy * 0.35),
        right: Math.round(theme.layout.padding.right * sx * 0.35),
        bottom: Math.round(theme.layout.padding.bottom * sy * 0.35),
        left: Math.round(theme.layout.padding.left * sx * 0.35),
      },
      textAreaWidth: Math.min(96, Math.max(theme.layout.textAreaWidth, 90)),
      textAreaHeight: Math.min(94, Math.max(theme.layout.textAreaHeight, 88)),
      referenceGap: Math.round((theme.layout.referenceGap ?? 0) * Math.min(sx, sy)),
    },
  }
}

export function mixPanelPercent(rect: MixPanelRect, canvasW: number, canvasH: number) {
  return {
    left: `${(rect.x / canvasW) * 100}%`,
    top: `${(rect.y / canvasH) * 100}%`,
    width: `${(rect.width / canvasW) * 100}%`,
    height: `${(rect.height / canvasH) * 100}%`,
  }
}
