import { memo, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import type { TimelineClip, VideoEditorProject } from "@/types/video-editor"
import {
  assetById,
  clipDuration,
  clipEnd,
  clipsOnTrack,
  projectDuration,
  snapCandidates,
  snapTime,
  trackById,
  trimClipEnd,
  trimClipStart,
} from "@/lib/video-editor/timeline"
import { useVideoEditorStore } from "@/stores/video-editor-store"

type DragMode = "move" | "trim-start" | "trim-end" | "playhead"

type DragState =
  | {
      mode: "playhead"
      pointerId: number
    }
  | {
      mode: "move" | "trim-start" | "trim-end"
      clipId: string
      pointerId: number
      originX: number
      originY: number
      originStart: number
      originTrackId: string
      originSourceIn: number
      originSourceOut: number
    }

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}

function timeAt(
  clientX: number,
  rail: HTMLDivElement,
  zoom: number,
  scrollLeft: number,
): number {
  const rect = rail.getBoundingClientRect()
  return Math.max(0, (clientX - rect.left + scrollLeft) / zoom)
}

function trackAtY(project: VideoEditorProject, clientY: number, rail: HTMLDivElement): string {
  const rect = rail.getBoundingClientRect()
  const y = clientY - rect.top
  // Row heights must match render below.
  const header = 28
  const videoRow = 64
  const audioRow = 52
  const videoTop = header
  const a1Top = videoTop + videoRow
  const a2Top = a1Top + audioRow

  if (y < a1Top) return "V1"
  if (y < a2Top) return project.tracks.find((t) => t.id === "A1")?.id ?? "A1"
  return project.tracks.find((t) => t.id === "A2")?.id ?? "A2"
}

const Clip = memo(function Clip({
  clip,
  zoom,
  selected,
  assetLabel,
  kind,
  waveform,
  onPointerDown,
}: {
  clip: TimelineClip
  zoom: number
  selected: boolean
  assetLabel: string
  kind: "video" | "audio"
  waveform?: number[]
  onPointerDown: (event: React.PointerEvent, mode: DragMode, clipId: string) => void
}) {
  const left = clip.timelineStart * zoom
  const width = Math.max(4, clipDuration(clip) * zoom)
  const bars = useMemo(() => {
    if (!waveform || waveform.length === 0) return null
    const count = Math.max(12, Math.min(56, Math.floor(width / 10)))
    const step = Math.max(1, Math.floor(waveform.length / count))
    const sampled: number[] = []
    for (let i = 0; i < waveform.length; i += step) sampled.push(waveform[i]!)
    if (sampled.length > count) sampled.length = count
    return sampled
  }, [waveform, width])
  return (
    <div
      className={cn(
        "group absolute top-2 h-10 rounded-md border text-[0.65rem] shadow-sm",
        kind === "video"
          ? "border-sky-400/40 bg-sky-500/12 text-sky-100"
          : "border-emerald-400/40 bg-emerald-500/10 text-emerald-100",
        selected && "ring-2 ring-sky-400/50",
        clip.locked && "opacity-60",
      )}
      style={{ left, width }}
      onPointerDown={(event) => onPointerDown(event, "move", clip.id)}
      title={assetLabel}
    >
      {kind === "audio" && bars ? (
        <div className="absolute inset-x-2 inset-y-2 flex items-end gap-px opacity-60">
          {bars.map((value, index) => (
            <div
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              className="w-1 flex-1 rounded-sm bg-emerald-200/70"
              style={{ height: `${Math.max(10, Math.round(value * 100))}%` }}
            />
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md bg-white/10 opacity-0 transition-opacity group-hover:opacity-100"
        onPointerDown={(event) => onPointerDown(event, "trim-start", clip.id)}
        aria-label="Trim start"
      />
      <button
        type="button"
        className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md bg-white/10 opacity-0 transition-opacity group-hover:opacity-100"
        onPointerDown={(event) => onPointerDown(event, "trim-end", clip.id)}
        aria-label="Trim end"
      />
      <div className="flex h-full items-center gap-2 px-2">
        <span className="truncate font-medium">{assetLabel}</span>
        <span className="ml-auto shrink-0 font-mono text-[0.6rem] text-white/60">
          {formatClock(clipDuration(clip))}
        </span>
      </div>
    </div>
  )
})

export function CapcutTimeline() {
  const project = useVideoEditorStore((s) => s.project)
  const zoom = useVideoEditorStore((s) => s.zoom)
  const playhead = useVideoEditorStore((s) => s.playhead)
  const snap = useVideoEditorStore((s) => s.snap)
  const selected = useVideoEditorStore((s) => s.selectedClipIds)

  const setPlayhead = useVideoEditorStore((s) => s.setPlayhead)
  const setZoom = useVideoEditorStore((s) => s.setZoom)
  const setSelectedClipIds = useVideoEditorStore((s) => s.setSelectedClipIds)
  const selectClip = useVideoEditorStore((s) => s.selectClip)
  const updateClip = useVideoEditorStore((s) => s.updateClip)
  const addClip = useVideoEditorStore((s) => s.addClip)

  const railRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [draft, setDraft] = useState<Record<string, TimelineClip> | null>(null)

  const duration = useMemo(() => (project ? projectDuration(project) : 0), [project])

  const width = Math.max(900, Math.round((duration + 3) * zoom))

  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const x = playhead * zoom
    const viewLeft = rail.scrollLeft
    const viewRight = viewLeft + rail.clientWidth
    const pad = Math.min(80, rail.clientWidth * 0.15)
    if (x < viewLeft + pad) {
      rail.scrollLeft = Math.max(0, x - pad)
    } else if (x > viewRight - pad) {
      rail.scrollLeft = Math.max(0, x - rail.clientWidth + pad)
    }
  }, [playhead, zoom, selected[0]])

  const candidates = useMemo(() => {
    if (!project) return []
    return snapCandidates(project, drag && "clipId" in drag ? drag.clipId : undefined)
  }, [project, drag])

  if (!project) return null

  const renderClip = (clip: TimelineClip) => {
    const current = draft?.[clip.id] ?? clip
    const asset = assetById(project, current.assetId)
    const track = trackById(project, current.trackId)
    const kind = track?.kind === "audio" ? "audio" : "video"
    return (
      <Clip
        key={clip.id}
        clip={current}
        zoom={zoom}
        selected={selected.includes(clip.id)}
        assetLabel={asset?.label ?? clip.assetId}
        kind={kind}
        waveform={kind === "audio" ? asset?.waveformPeaks : undefined}
        onPointerDown={(event, mode, clipId) => {
          event.preventDefault()
          event.stopPropagation()
          if (!selected.includes(clipId)) {
            selectClip(clipId, event.shiftKey)
          } else if (event.shiftKey) {
            selectClip(clipId, true)
          }
          if (mode === "move" || mode === "trim-start" || mode === "trim-end") {
            const clip = project.clips.find((c) => c.id === clipId)
            if (!clip || clip.locked) return
            const rail = railRef.current
            if (!rail) return
            rail.setPointerCapture(event.pointerId)
            setDrag({
              mode,
              clipId,
              pointerId: event.pointerId,
              originX: event.clientX,
              originY: event.clientY,
              originStart: clip.timelineStart,
              originTrackId: clip.trackId,
              originSourceIn: clip.sourceIn,
              originSourceOut: clip.sourceOut,
            })
            setDraft({ [clipId]: clip })
          }
        }}
      />
    )
  }

  const onPointerDownRail = (event: React.PointerEvent) => {
    const rail = railRef.current
    if (!rail) return
    rail.setPointerCapture(event.pointerId)
    setDrag({ mode: "playhead", pointerId: event.pointerId })
    const t = timeAt(event.clientX, rail, zoom, rail.scrollLeft)
    setPlayhead(t)
    setSelectedClipIds([])
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag) return
    const rail = railRef.current
    if (!rail) return
    if (drag.mode === "playhead") {
      const t = timeAt(event.clientX, rail, zoom, rail.scrollLeft)
      setPlayhead(t)
      return
    }
    const clip = project.clips.find((c) => c.id === drag.clipId)
    if (!clip) return
    const deltaSeconds = (event.clientX - drag.originX) / zoom
    const nextTrackId = trackAtY(project, event.clientY, rail)
    const asset = assetById(project, clip.assetId)
    const assetDuration = asset?.durationSeconds ?? clip.sourceOut

    let next: TimelineClip = {
      ...clip,
      trackId: nextTrackId,
      timelineStart: Math.max(0, drag.originStart + deltaSeconds),
      sourceIn: drag.originSourceIn,
      sourceOut: drag.originSourceOut,
    }

    if (drag.mode === "trim-start") {
      next = trimClipStart(
        { ...clip, timelineStart: drag.originStart, sourceIn: drag.originSourceIn },
        drag.originStart + deltaSeconds,
      )
    } else if (drag.mode === "trim-end") {
      next = trimClipEnd(
        { ...clip, timelineStart: drag.originStart, sourceIn: drag.originSourceIn, sourceOut: drag.originSourceOut },
        clipEnd(clip) + deltaSeconds,
        assetDuration,
      )
    }

    if (snap && drag.mode !== "trim-start") {
      const threshold = 0.08
      const snapped = snapTime(next.timelineStart, candidates, threshold)
      next = { ...next, timelineStart: snapped }
    }

    setDraft({ [drag.clipId]: next })
    if (drag.mode === "move") {
      setPlayhead(next.timelineStart)
    }
  }

  const onPointerUp = () => {
    if (!drag) return
    if (drag.mode !== "playhead") {
      const next = draft?.[drag.clipId]
      if (next) {
        updateClip(drag.clipId, () => next)
      }
    }
    setDrag(null)
    setDraft(null)
  }

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const assetId = event.dataTransfer.getData("application/x-rhema-asset")
    if (!assetId) return
    const rail = railRef.current
    if (!rail) return
    const t = timeAt(event.clientX, rail, zoom, rail.scrollLeft)
    const trackId = trackAtY(project, event.clientY, rail)
    addClip(assetId, trackId, t)
  }

  const videoClips = clipsOnTrack(project, "V1")
  const audioTracks = project.tracks.filter((t) => t.kind === "audio")

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0c0e12]">
      <div className="flex h-7 items-center justify-between border-b border-white/5 px-3 text-[0.625rem] text-muted-foreground">
        <span className="font-medium tracking-wider uppercase">Timeline</span>
        <span className="font-mono tabular-nums">
          {formatClock(playhead)} / {formatClock(duration)}
        </span>
      </div>
      <div
        ref={railRef}
        className="relative min-h-0 flex-1 overflow-auto"
        onPointerDown={onPointerDownRail}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(event) => {
          if (!event.ctrlKey) return
          event.preventDefault()
          setZoom(zoom + (event.deltaY > 0 ? -10 : 10))
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <div className="relative" style={{ width, height: 28 + 64 + audioTracks.length * 52 }}>
          <div className="absolute inset-x-0 top-0 h-7 border-b border-white/5 bg-[#101218]" />
          {/* Ruler */}
          <div className="absolute left-0 top-0 h-7 w-full">
            {Array.from({ length: Math.ceil((duration + 3) / 5) + 1 }).map((_, i) => {
              const t = i * 5
              const x = t * zoom
              return (
                <div
                  key={t}
                  className="absolute top-0 flex h-7 items-center"
                  style={{ left: x }}
                >
                  <div className="h-3 w-px bg-white/15" />
                  <span className="ml-1 text-[0.55rem] text-white/35">
                    {formatClock(t)}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Playhead */}
          <div
            className="pointer-events-none absolute top-0 z-20 h-full w-px bg-white"
            style={{ left: playhead * zoom }}
          >
            <div className="absolute -top-0.5 left-1/2 size-2 -translate-x-1/2 rounded-sm bg-white" />
          </div>

          {/* Tracks */}
          <div className="absolute left-0 top-7 w-full">
            <div className="relative h-16 border-b border-white/5">
              <div className="absolute left-2 top-2 text-[0.6rem] font-semibold text-sky-200">
                V1
              </div>
              {videoClips.map(renderClip)}
            </div>
            {audioTracks.map((track) => (
              <div key={track.id} className="relative h-[52px] border-b border-white/5">
                <div className="absolute left-2 top-2 text-[0.6rem] font-semibold text-emerald-200">
                  {track.name}
                </div>
                {clipsOnTrack(project, track.id).map(renderClip)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

