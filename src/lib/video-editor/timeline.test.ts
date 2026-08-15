import { describe, expect, it } from "vitest"
import type { TimelineClip, VideoEditorProject } from "@/types/video-editor"
import {
  clipDuration,
  clipEnd,
  clipsForAsset,
  createEmptyProject,
  moveClip,
  projectDuration,
  snapTime,
  splitClipAtPlayhead,
  trimClipEnd,
  trimClipStart,
  validateProject,
} from "./timeline"

function clip(partial: Partial<TimelineClip> & Pick<TimelineClip, "id">): TimelineClip {
  return {
    trackId: "V1",
    assetId: "asset-1",
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 10,
    muted: false,
    muteEmbeddedAudio: false,
    volume: 1,
    locked: false,
    ...partial,
  }
}

describe("timeline helpers", () => {
  it("computes clip and project duration", () => {
    const project: VideoEditorProject = {
      ...createEmptyProject("p1", "Demo"),
      assets: [
        {
          id: "asset-1",
          kind: "video",
          role: "program",
          label: "Clip",
          path: "/a.mp4",
          durationSeconds: 20,
          hasEmbeddedAudio: true,
          offline: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      clips: [clip({ id: "c1", timelineStart: 2, sourceIn: 1, sourceOut: 6 })],
    }
    expect(clipDuration(project.clips[0]!)).toBe(5)
    expect(clipEnd(project.clips[0]!)).toBe(7)
    expect(projectDuration(project)).toBe(7)
  })

  it("finds clips for a library asset by id or path", () => {
    const project: VideoEditorProject = {
      ...createEmptyProject("p1", "Demo"),
      assets: [
        {
          id: "asset-1",
          kind: "video",
          role: "program",
          label: "Clip",
          path: "/a.mp4",
          durationSeconds: 20,
          hasEmbeddedAudio: true,
          offline: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      clips: [clip({ id: "c1", assetId: "asset-1", timelineStart: 4 })],
    }
    const fromLibrary = {
      ...project.assets[0]!,
      id: "library-copy",
    }
    expect(clipsForAsset(project, project.assets[0]!)[0]?.id).toBe("c1")
    expect(clipsForAsset(project, fromLibrary)[0]?.id).toBe("c1")
  })

  it("snaps near candidates", () => {
    expect(snapTime(4.9, [0, 5, 10], 0.25)).toBe(5)
    expect(snapTime(4.4, [0, 5, 10], 0.25)).toBe(4.4)
  })

  it("trims and splits clips", () => {
    const base = clip({ id: "c1", timelineStart: 0, sourceIn: 0, sourceOut: 10 })
    const trimmedStart = trimClipStart(base, 2)
    expect(trimmedStart.timelineStart).toBe(2)
    expect(trimmedStart.sourceIn).toBe(2)
    expect(trimmedStart.sourceOut).toBe(10)

    const trimmedEnd = trimClipEnd(base, 7, 10)
    expect(trimmedEnd.sourceOut).toBe(7)

    const split = splitClipAtPlayhead(base, 4, "c2")
    expect(split).not.toBeNull()
    expect(split![0].sourceOut).toBe(4)
    expect(split![1].timelineStart).toBe(4)
    expect(split![1].sourceIn).toBe(4)
  })

  it("moves clips and validates projects", () => {
    const moved = moveClip(clip({ id: "c1" }), 3.5, "A1")
    expect(moved.timelineStart).toBe(3.5)
    expect(moved.trackId).toBe("A1")

    const project = createEmptyProject("p1", "Demo")
    project.clips.push(clip({ id: "bad", assetId: "missing" }))
    expect(validateProject(project).some((error) => error.includes("missing asset"))).toBe(
      true,
    )
  })
})
