import type {
  MediaAsset,
  TimelineClip,
  TimelineTrack,
  VideoEditorProject,
} from "@/types/video-editor"
import { DEFAULT_TRACKS } from "@/types/video-editor"

export function clipDuration(clip: TimelineClip): number {
  return Math.max(0, clip.sourceOut - clip.sourceIn)
}

export function clipEnd(clip: TimelineClip): number {
  return clip.timelineStart + clipDuration(clip)
}

export function projectDuration(project: VideoEditorProject): number {
  let max = 0
  for (const clip of project.clips) {
    max = Math.max(max, clipEnd(clip))
  }
  return max
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function snapTime(
  time: number,
  candidates: number[],
  threshold: number,
): number {
  let best = time
  let bestDelta = threshold
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - time)
    if (delta <= bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }
  return best
}

export function snapCandidates(
  project: VideoEditorProject,
  excludeClipId?: string,
): number[] {
  const points = [0]
  for (const clip of project.clips) {
    if (clip.id === excludeClipId) continue
    points.push(clip.timelineStart, clipEnd(clip))
  }
  return points
}

export function clipsOnTrack(
  project: VideoEditorProject,
  trackId: string,
): TimelineClip[] {
  // Avoid newer Array.prototype.toSorted() for WebView2 compatibility.
  return project.clips
    .filter((clip) => clip.trackId === trackId)
    .slice()
    .sort((a, b) => a.timelineStart - b.timelineStart)
}

export function trackById(
  project: VideoEditorProject,
  trackId: string,
): TimelineTrack | undefined {
  return project.tracks.find((track) => track.id === trackId)
}

export function assetById(
  project: VideoEditorProject,
  assetId: string,
): MediaAsset | undefined {
  return project.assets.find((asset) => asset.id === assetId)
}

export function clipsForAsset(
  project: VideoEditorProject,
  asset: MediaAsset,
): TimelineClip[] {
  const ids = new Set<string>([asset.id])
  for (const existing of project.assets) {
    if (existing.id === asset.id || existing.path === asset.path) {
      ids.add(existing.id)
    }
  }
  return project.clips
    .filter((clip) => ids.has(clip.assetId))
    .slice()
    .sort((a, b) => a.timelineStart - b.timelineStart)
}

export function canPlaceAssetOnTrack(
  asset: MediaAsset,
  track: TimelineTrack,
): boolean {
  if (track.kind === "video") return asset.kind === "video"
  return asset.kind === "audio" || asset.kind === "video"
}

export function findClipAtPlayhead(
  project: VideoEditorProject,
  trackId: string,
  playhead: number,
): TimelineClip | null {
  for (const clip of clipsOnTrack(project, trackId)) {
    if (playhead >= clip.timelineStart && playhead < clipEnd(clip)) {
      return clip
    }
  }
  return null
}

/** Source time inside a clip for a timeline playhead. */
export function sourceTimeAtPlayhead(
  clip: TimelineClip,
  playhead: number,
): number {
  const offset = clamp(playhead - clip.timelineStart, 0, clipDuration(clip))
  return clip.sourceIn + offset
}

export function moveClip(
  clip: TimelineClip,
  timelineStart: number,
  trackId: string,
): TimelineClip {
  return {
    ...clip,
    trackId,
    timelineStart: Math.max(0, timelineStart),
  }
}

export function trimClipStart(
  clip: TimelineClip,
  newTimelineStart: number,
  minDuration = 0.05,
): TimelineClip {
  const end = clipEnd(clip)
  const nextStart = clamp(newTimelineStart, 0, end - minDuration)
  const delta = nextStart - clip.timelineStart
  return {
    ...clip,
    timelineStart: nextStart,
    sourceIn: clip.sourceIn + delta,
  }
}

export function trimClipEnd(
  clip: TimelineClip,
  newTimelineEnd: number,
  assetDuration: number,
  minDuration = 0.05,
): TimelineClip {
  const maxOut = assetDuration
  const nextEnd = clamp(
    newTimelineEnd,
    clip.timelineStart + minDuration,
    clip.timelineStart + (maxOut - clip.sourceIn),
  )
  return {
    ...clip,
    sourceOut: clip.sourceIn + (nextEnd - clip.timelineStart),
  }
}

export function splitClipAtPlayhead(
  clip: TimelineClip,
  playhead: number,
  newId: string,
  minDuration = 0.05,
): [TimelineClip, TimelineClip] | null {
  if (
    playhead <= clip.timelineStart + minDuration ||
    playhead >= clipEnd(clip) - minDuration
  ) {
    return null
  }
  const sourceSplit = sourceTimeAtPlayhead(clip, playhead)
  const left: TimelineClip = {
    ...clip,
    sourceOut: sourceSplit,
  }
  const right: TimelineClip = {
    ...clip,
    id: newId,
    timelineStart: playhead,
    sourceIn: sourceSplit,
  }
  return [left, right]
}

export function nextVideoAppendStart(project: VideoEditorProject): number {
  const videoClips = project.clips.filter((clip) => {
    const track = trackById(project, clip.trackId)
    return track?.kind === "video"
  })
  if (videoClips.length === 0) return 0
  return Math.max(...videoClips.map(clipEnd))
}

export function createEmptyProject(
  id: string,
  title: string,
  now = new Date().toISOString(),
): VideoEditorProject {
  return {
    version: 1,
    id,
    title,
    createdAt: now,
    updatedAt: now,
    assets: [],
    tracks: DEFAULT_TRACKS.map((track) => ({ ...track })),
    clips: [],
  }
}

export function validateProject(project: VideoEditorProject): string[] {
  const errors: string[] = []
  if (project.version !== 1) errors.push("Unsupported project version")
  if (!project.id.trim()) errors.push("Project id is required")
  const trackIds = new Set(project.tracks.map((track) => track.id))
  const assetIds = new Set(project.assets.map((asset) => asset.id))
  for (const clip of project.clips) {
    if (!trackIds.has(clip.trackId)) {
      errors.push(`Clip ${clip.id} references missing track ${clip.trackId}`)
    }
    if (!assetIds.has(clip.assetId)) {
      errors.push(`Clip ${clip.id} references missing asset ${clip.assetId}`)
    }
    if (!(clip.sourceOut > clip.sourceIn)) {
      errors.push(`Clip ${clip.id} has an invalid source range`)
    }
    if (!Number.isFinite(clip.timelineStart) || clip.timelineStart < 0) {
      errors.push(`Clip ${clip.id} has an invalid timeline start`)
    }
  }
  return errors
}

export function newClipId(): string {
  return `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
