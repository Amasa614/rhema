import { useEffect, useMemo, useRef, useState } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { openPath } from "@tauri-apps/plugin-opener"
import {
  ArrowLeftRightIcon,
  FolderPlusIcon,
  PauseIcon,
  PlayIcon,
  Redo2Icon,
  ScissorsIcon,
  Trash2Icon,
  Undo2Icon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { MediaAsset, TimelineClip, VideoEditorProject } from "@/types/video-editor"
import {
  assetById,
  clipDuration,
  clipEnd,
  clipsOnTrack,
  findClipAtPlayhead,
  projectDuration,
  sourceTimeAtPlayhead,
  trackById,
} from "@/lib/video-editor/timeline"
import { CapcutTimeline } from "@/components/post-production/capcut-timeline"
import { EditorExportDialog } from "@/components/post-production/editor-export-dialog"
import { useVideoEditorStore } from "@/stores/video-editor-store"

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}

function stopHtmlMedia(el: HTMLMediaElement) {
  try {
    el.pause()
    el.removeAttribute("src")
    el.src = ""
    el.load()
  } catch {
    // WebView2 can throw if the element is already torn down.
  }
}

function stopAudioPlayers(players: Map<string, HTMLAudioElement>) {
  for (const player of players.values()) {
    stopHtmlMedia(player)
  }
  players.clear()
}

function assetPreviewUrl(asset: MediaAsset | null): string | null {
  if (!asset) return null
  try {
    return convertFileSrc(asset.path)
  } catch {
    return null
  }
}

function resolveBinAsset(
  project: VideoEditorProject | null,
  library: MediaAsset[],
  assetId: string | null,
): MediaAsset | null {
  if (!assetId) return null
  return (
    (project ? assetById(project, assetId) : null) ??
    library.find((asset) => asset.id === assetId) ??
    null
  )
}

function MediaBinRow({
  asset,
  selected,
  onPreview,
  onPlace,
}: {
  asset: MediaAsset
  selected: boolean
  onPreview: (asset: MediaAsset) => void
  onPlace: (asset: MediaAsset) => void
}) {
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-rhema-asset", asset.id)
        event.dataTransfer.effectAllowed = "copyMove"
      }}
      onClick={() => onPreview(asset)}
      onDoubleClick={() => onPlace(asset)}
      className={cn(
        "mb-1 flex cursor-grab items-center gap-2 rounded-md border border-transparent p-2 text-left transition-colors active:cursor-grabbing",
        "hover:bg-muted/50",
        selected && "bg-sky-500/15 ring-1 ring-inset ring-sky-400/30",
        asset.offline && "opacity-60",
      )}
      title={asset.offline ? "Offline" : "Click to preview and show on the timeline"}
    >
      <span
        className={cn(
          "flex size-8 items-center justify-center rounded bg-white/5 text-[0.625rem] font-semibold",
          asset.kind === "video" && "text-sky-200",
          asset.kind === "audio" && "text-emerald-200",
          asset.kind === "image" && "text-violet-200",
        )}
      >
        {asset.kind === "video" ? "V" : asset.kind === "audio" ? "A" : "I"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-xs font-medium">{asset.label}</span>
        <span className="text-[0.5625rem] text-muted-foreground">
          {formatTime(asset.durationSeconds)}
        </span>
      </span>
    </div>
  )
}

function resolveActiveVideo(
  project: ReturnType<typeof useVideoEditorStore.getState>["project"],
  playhead: number,
): { clip: TimelineClip; asset: MediaAsset; sourceTime: number } | null {
  if (!project) return null
  const clip = findClipAtPlayhead(project, "V1", playhead)
  if (!clip) return null
  const asset = assetById(project, clip.assetId)
  if (!asset) return null
  if (asset.kind !== "video") return null
  const sourceTime = sourceTimeAtPlayhead(clip, playhead)
  return { clip, asset, sourceTime }
}

export function VideoEditorWorkspace() {
  const projects = useVideoEditorStore((s) => s.projects)
  const library = useVideoEditorStore((s) => s.library)
  const project = useVideoEditorStore((s) => s.project)
  const selectedClipIds = useVideoEditorStore((s) => s.selectedClipIds)
  const previewAssetId = useVideoEditorStore((s) => s.previewAssetId)
  const playhead = useVideoEditorStore((s) => s.playhead)
  const zoom = useVideoEditorStore((s) => s.zoom)
  const snap = useVideoEditorStore((s) => s.snap)
  const busy = useVideoEditorStore((s) => s.busy)
  const error = useVideoEditorStore((s) => s.error)
  const past = useVideoEditorStore((s) => s.past)
  const future = useVideoEditorStore((s) => s.future)
  const job = useVideoEditorStore((s) => s.job)

  const [titleDraft, setTitleDraft] = useState("")
  const [playing, setPlaying] = useState(false)
  const [sourceTime, setSourceTime] = useState(0)
  const [timelineHeight, setTimelineHeight] = useState(260)
  const timelineResizeRef = useRef<{
    pointerId: number
    originY: number
    originHeight: number
  } | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioPlayersRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const audioUrlByClipRef = useRef<Map<string, string>>(new Map())
  const primedAudioRef = useRef<Set<string>>(new Set())
  const assignedVideoUrlRef = useRef<string | null>(null)
  const lastVideoClipIdRef = useRef<string | null>(null)
  const playingRef = useRef(false)
  const togglePlaybackRef = useRef<() => void>(() => {})
  playingRef.current = playing

  useEffect(() => {
    void useVideoEditorStore.getState().refreshProjects()
    void useVideoEditorStore.getState().refreshLibrary()
  }, [])

  useEffect(() => {
    setTitleDraft(project?.title ?? "")
  }, [project?.id, project?.title])

  useEffect(() => {
    if (!error) return
    toast.error("Video editor error", { description: error })
  }, [error])

  useEffect(() => {
    if (!job) return
    if (job.status !== "completed") return
    toast.success("Export complete", {
      description: job.resultPath ?? "Saved.",
    })
  }, [job?.status, job?.resultPath])

  const duration = useMemo(() => (project ? projectDuration(project) : 0), [project])
  const activeVideo = useMemo(
    () => resolveActiveVideo(project, playhead),
    [project, playhead],
  )
  const previewAsset = useMemo(
    () => resolveBinAsset(project, library, previewAssetId),
    [project, library, previewAssetId],
  )
  const sourcePreview = Boolean(previewAsset && !previewAsset.offline)

  const selectedClip = useMemo(() => {
    if (!project) return null
    const id = selectedClipIds[0]
    if (!id) return null
    return project.clips.find((clip) => clip.id === id) ?? null
  }, [project, selectedClipIds])

  const selectedAsset = useMemo(() => {
    if (!project || !selectedClip) return null
    return assetById(project, selectedClip.assetId) ?? null
  }, [project, selectedClip])

  const inspectorAsset = selectedAsset ?? previewAsset

  const previewUrl = useMemo(() => {
    if (sourcePreview && previewAsset) return assetPreviewUrl(previewAsset)
    if (previewAsset?.kind === "image") return assetPreviewUrl(previewAsset)
    return assetPreviewUrl(activeVideo?.asset ?? null)
  }, [sourcePreview, previewAsset, activeVideo?.asset?.path])

  const previewKind: MediaAsset["kind"] | null = sourcePreview
    ? previewAsset?.kind ?? null
    : activeVideo
      ? "video"
      : previewAsset?.kind === "image"
        ? "image"
        : null

  useEffect(() => {
    setSourceTime(0)
    setPlaying(false)
  }, [previewAssetId])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (sourcePreview && previewAsset && previewUrl) {
      if (previewAsset.kind === "image") {
        if (!video.paused) video.pause()
        return
      }
      if (assignedVideoUrlRef.current !== previewUrl) {
        assignedVideoUrlRef.current = previewUrl
        lastVideoClipIdRef.current = null
      }
      video.muted = false
      video.volume = 1
      return
    }
    if (!activeVideo || !previewUrl) {
      if (!playingRef.current) {
        if (!video.paused) video.pause()
        setPlaying(false)
      }
      return
    }
    if (assignedVideoUrlRef.current !== previewUrl) {
      assignedVideoUrlRef.current = previewUrl
      lastVideoClipIdRef.current = null
      if (!video.src || video.getAttribute("src") !== previewUrl) {
        video.src = previewUrl
      }
    }

    video.muted = activeVideo.clip.muted || activeVideo.clip.muteEmbeddedAudio
    video.volume = Math.max(0, Math.min(activeVideo.clip.volume ?? 1, 2))

    const clipChanged = lastVideoClipIdRef.current !== activeVideo.clip.id
    const desired = activeVideo.sourceTime
    // Seeking while playing causes a visible hitch in WebView2. Only snap
    // when scrubbing or when the active clip changes.
    const shouldSeek =
      Number.isFinite(desired) &&
      (clipChanged || !playingRef.current) &&
      Math.abs(video.currentTime - desired) > (clipChanged ? 0.02 : 0.04)
    if (shouldSeek) {
      video.currentTime = desired
    }
    lastVideoClipIdRef.current = activeVideo.clip.id

    if (playingRef.current && video.paused && !video.seeking) {
      void video.play().catch(() => setPlaying(false))
    }
  }, [
    activeVideo?.clip.id,
    activeVideo?.clip.muted,
    activeVideo?.clip.muteEmbeddedAudio,
    activeVideo?.clip.volume,
    activeVideo?.sourceTime,
    previewUrl,
    sourcePreview,
    previewAsset,
  ])

  const togglePlayback = () => {
    const video = videoRef.current
    if (!video) return
    if (!project) return

    if (sourcePreview && previewAsset) {
      if (previewAsset.kind === "image") return
      if (video.paused) {
        setPlaying(true)
        void video.play().catch(() => setPlaying(false))
        return
      }
      video.pause()
      setPlaying(false)
      return
    }

    const nowActive = activeVideo ?? resolveActiveVideo(project, playhead)
    if (!nowActive) {
      const next = clipsOnTrack(project, "V1").find((clip) => clip.timelineStart >= playhead)
      if (!next) return
      useVideoEditorStore.getState().setPlayhead(next.timelineStart)
    }

    if (video.paused) {
      setPlaying(true)
      void video.play().catch(() => setPlaying(false))
      return
    }
    video.pause()
    setPlaying(false)
  }
  togglePlaybackRef.current = togglePlayback

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return

      if (event.code === "Space") {
        event.preventDefault()
        togglePlaybackRef.current()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault()
        if (event.shiftKey) useVideoEditorStore.getState().redo()
        else useVideoEditorStore.getState().undo()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault()
        useVideoEditorStore.getState().duplicateSelected()
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault()
        useVideoEditorStore.getState().deleteSelected()
      }
      if (event.key.toLowerCase() === "s") {
        useVideoEditorStore.getState().splitSelectedAtPlayhead()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const syncAudioPlayers = (
    project: VideoEditorProject,
    playhead: number,
    playing: boolean,
    mode: "scrub" | "play",
  ) => {
    const players = audioPlayersRef.current
    const urls = audioUrlByClipRef.current
    const audioTracks = project.tracks.filter((t) => t.kind === "audio")
    const active = new Set<string>()

    for (const track of audioTracks) {
      const trackMuted = track.muted
      for (const clip of clipsOnTrack(project, track.id)) {
        const end = clipEnd(clip)
        if (playhead < clip.timelineStart || playhead >= end) continue
        const asset = assetById(project, clip.assetId)
        if (!asset || asset.offline) continue
        if (!asset.hasEmbeddedAudio) continue
        active.add(clip.id)

        const url = assetPreviewUrl(asset)
        if (!url) continue

        let player = players.get(clip.id)
        if (!player) {
          player = new Audio()
          player.preload = "auto"
          players.set(clip.id, player)
        }
        if (urls.get(clip.id) !== url) {
          player.src = url
          urls.set(clip.id, url)
          primedAudioRef.current.delete(clip.id)
        }
        player.muted = trackMuted || clip.muted
        player.volume = Math.max(0, Math.min(clip.volume ?? 1, 2))

        const desired = clip.sourceIn + (playhead - clip.timelineStart)
        const drift = Number.isFinite(desired)
          ? Math.abs(player.currentTime - desired)
          : 0
        const unprimed = !primedAudioRef.current.has(clip.id)
        const shouldSeek =
          Number.isFinite(desired) &&
          (mode === "scrub" || unprimed || drift > 0.4)
        if (shouldSeek) {
          player.currentTime = desired
          primedAudioRef.current.add(clip.id)
        }
        if (playing && !player.muted && player.paused) {
          void player.play().catch(() => {})
        }
        if (!playing && !player.paused) player.pause()
      }
    }

    for (const [clipId, player] of players) {
      if (active.has(clipId)) continue
      stopHtmlMedia(player)
      players.delete(clipId)
      urls.delete(clipId)
      primedAudioRef.current.delete(clipId)
    }
  }

  useEffect(() => {
    if (!playing) return
    primedAudioRef.current.clear()
    const video = videoRef.current
    if (!video || !project) return

    let raf = 0
    let last = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (!playingRef.current) return
      const now = performance.now()
      if (now - last < 33) return
      last = now

      const previewId = useVideoEditorStore.getState().previewAssetId
      if (previewId) {
        setSourceTime(video.currentTime)
        const asset = resolveBinAsset(project, library, previewId)
        const end = asset?.durationSeconds ?? video.duration
        if (video.ended || (Number.isFinite(end) && video.currentTime >= end - 0.05)) {
          video.pause()
          setPlaying(false)
        }
        return
      }

      const currentPlayhead = useVideoEditorStore.getState().playhead
      const active = resolveActiveVideo(project, currentPlayhead)
      if (!active) {
        const next = clipsOnTrack(project, "V1").find(
          (clip) => clip.timelineStart > currentPlayhead,
        )
        if (!next) {
          video.pause()
          setPlaying(false)
          return
        }
        useVideoEditorStore.getState().setPlayhead(next.timelineStart)
        return
      }
      const nextPlayhead =
        active.clip.timelineStart + (video.currentTime - active.clip.sourceIn)
      useVideoEditorStore.getState().setPlayhead(nextPlayhead)

      if (video.currentTime >= active.clip.sourceOut - 0.02) {
        const next = clipsOnTrack(project, "V1").find((clip) => clip.timelineStart >= clipEnd(active.clip) - 0.001)
        if (next) {
          useVideoEditorStore.getState().setPlayhead(next.timelineStart)
        } else {
          video.pause()
          setPlaying(false)
        }
      }

      syncAudioPlayers(project, nextPlayhead, true, "play")

      if (nextPlayhead >= duration - 0.03) {
        video.pause()
        setPlaying(false)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, project, duration, library])

  useEffect(() => {
    if (!project) {
      stopAudioPlayers(audioPlayersRef.current)
      audioUrlByClipRef.current.clear()
      primedAudioRef.current.clear()
      const video = videoRef.current
      if (video) stopHtmlMedia(video)
      assignedVideoUrlRef.current = null
      lastVideoClipIdRef.current = null
      setPlaying(false)
      return
    }
    if (playing && !sourcePreview) return
    syncAudioPlayers(project, playhead, false, "scrub")
  }, [project, playhead, playing, sourcePreview])

  useEffect(() => {
    return () => {
      stopAudioPlayers(audioPlayersRef.current)
      const video = videoRef.current
      if (video) stopHtmlMedia(video)
    }
  }, [project?.id])

  const importVideo = async () => {
    if (!project) return
    const path = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm"] }],
    })
    if (!path || typeof path !== "string") return
    await useVideoEditorStore.getState().importMedia(path)
  }

  const importAudio = async () => {
    if (!project) return
    const path = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "aac"] }],
    })
    if (!path || typeof path !== "string") return
    await useVideoEditorStore.getState().importMedia(path)
  }

  const startFromRecordingCandidates = useMemo(() => {
    return library
      .filter((asset) => asset.kind === "video" && Boolean(asset.recordingId))
      .slice(0, 10)
  }, [library])

  const previewMedia = (asset: MediaAsset) => {
    if (asset.offline) return
    setPlaying(false)
    useVideoEditorStore.getState().focusAsset(asset.id)
  }

  if (!project) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Video editor</h2>
            <p className="text-xs text-muted-foreground">
              Start from a recording, then drag clips onto the timeline.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={() => void useVideoEditorStore.getState().createProject()}
            >
              <FolderPlusIcon className="size-4" />
              New project
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void useVideoEditorStore.getState().refreshProjects()}
            >
              Refresh
            </Button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 p-6">
          <div className="min-h-0 overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Recent projects
              </p>
            </div>
            <div className="min-h-0 overflow-y-auto p-2">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className="mb-2 rounded-lg border border-border/60 bg-background/40 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{p.title}</p>
                      <p className="mt-1 text-[0.625rem] text-muted-foreground">
                        {p.clipCount} clips · {formatTime(p.durationSeconds)} ·{" "}
                        {new Date(p.updatedAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        onClick={() => void useVideoEditorStore.getState().loadProject(p.id)}
                      >
                        Open
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() =>
                          void useVideoEditorStore.getState().deleteProject(p.id)
                        }
                        title="Delete project"
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              {projects.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No projects yet.
                </p>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Start from a recording
              </p>
            </div>
            <div className="min-h-0 overflow-y-auto p-2">
              {startFromRecordingCandidates.map((asset) => (
                <div
                  key={asset.id}
                  className={cn(
                    "mb-2 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 p-3",
                    asset.offline && "opacity-60",
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{asset.label}</p>
                    <p className="mt-1 text-[0.625rem] text-muted-foreground">
                      {formatTime(asset.durationSeconds)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={busy || asset.offline || !asset.recordingId}
                    onClick={() =>
                      void useVideoEditorStore
                        .getState()
                        .createProjectFromRecording(asset.recordingId!)
                    }
                  >
                    Start edit
                  </Button>
                </div>
              ))}
              {startFromRecordingCandidates.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Record a program video first (top bar Record).
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const videoClips = clipsOnTrack(project, "V1")
  const canSplit = Boolean(
    selectedClip && playhead > selectedClip.timelineStart + 0.05 && playhead < clipEnd(selectedClip) - 0.05,
  )

  return (
    <div
      className="relative grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)_320px]"
      style={{
        gridTemplateRows: `auto minmax(0,1fr) 8px ${Math.max(160, Math.min(timelineHeight, 520))}px`,
      }}
    >
      <header className="col-span-3 flex items-center gap-3 border-b border-border bg-card/40 px-4 py-3">
        <Input
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value)}
          onBlur={() => useVideoEditorStore.getState().setProjectTitle(titleDraft)}
          className="h-9 max-w-xl border-transparent bg-transparent px-1 text-base font-semibold shadow-none focus-visible:border-border focus-visible:ring-0"
        />
        <div className="flex-1" />
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={past.length === 0 || busy}
          onClick={() => useVideoEditorStore.getState().undo()}
          title="Undo (Ctrl/Cmd+Z)"
        >
          <Undo2Icon className="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={future.length === 0 || busy}
          onClick={() => useVideoEditorStore.getState().redo()}
          title="Redo (Ctrl/Cmd+Shift+Z)"
        >
          <Redo2Icon className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => useVideoEditorStore.getState().setExportOpen(true)}
        >
          <UploadIcon className="size-4" />
          Export
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            stopAudioPlayers(audioPlayersRef.current)
            const video = videoRef.current
            if (video) stopHtmlMedia(video)
            setPlaying(false)
            useVideoEditorStore.getState().closeProject()
          }}
        >
          Close
        </Button>
      </header>

      <aside className="col-start-1 row-start-2 flex min-h-0 flex-col border-r border-border bg-card/40">
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
          <span className="text-[0.625rem] font-semibold tracking-wider text-muted-foreground uppercase">
            Media
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              title="Import video"
              onClick={() => void importVideo()}
            >
              <FolderPlusIcon className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={busy}
              title="Import audio"
              onClick={() => void importAudio()}
            >
              <ArrowLeftRightIcon className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <p className="px-2 py-1 text-[0.6rem] font-semibold tracking-wider text-muted-foreground uppercase">
            Project assets
          </p>
          {project.assets.map((asset) => (
            <MediaBinRow
              key={asset.id}
              asset={asset}
              selected={
                previewAssetId === asset.id ||
                selectedClip?.assetId === asset.id ||
                selectedAsset?.path === asset.path
              }
              onPreview={previewMedia}
              onPlace={previewMedia}
            />
          ))}

          <p className="mt-3 px-2 py-1 text-[0.6rem] font-semibold tracking-wider text-muted-foreground uppercase">
            Library
          </p>
          {library.slice(0, 30).map((asset) => (
            <MediaBinRow
              key={asset.id}
              asset={asset}
              selected={
                previewAssetId === asset.id ||
                selectedClip?.assetId === asset.id ||
                selectedAsset?.path === asset.path
              }
              onPreview={previewMedia}
              onPlace={previewMedia}
            />
          ))}
        </div>
      </aside>

      <main className="col-start-2 row-start-2 flex min-h-0 flex-col bg-black">
        <div className="flex min-h-0 flex-1 p-2">
          <div className="flex min-h-0 flex-1 rounded-md bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            {previewKind === "image" && previewUrl ? (
              <img
                src={previewUrl}
                alt={previewAsset?.label ?? "Preview"}
                className="h-full w-full flex-1 rounded-md bg-black object-contain"
              />
            ) : previewUrl ? (
              <div className="relative h-full w-full flex-1">
                <video
                  key={previewUrl}
                  ref={videoRef}
                  src={previewUrl}
                  playsInline
                  className="h-full w-full rounded-md bg-black object-contain"
                  onPlay={() => setPlaying(true)}
                  onPause={() => {
                    if (videoRef.current?.seeking) return
                    setPlaying(false)
                  }}
                  onTimeUpdate={(event) => {
                    if (useVideoEditorStore.getState().previewAssetId) {
                      setSourceTime(event.currentTarget.currentTime)
                    }
                  }}
                />
                {previewKind === "audio" ? (
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
                    <span className="rounded bg-emerald-500/20 px-2 py-1 text-[0.625rem] font-semibold tracking-wider text-emerald-200 uppercase">
                      Audio
                    </span>
                    <span className="max-w-[80%] truncate px-3 text-sm text-white/90">
                      {previewAsset?.label}
                    </span>
                  </div>
                ) : null}
                {sourcePreview && previewKind === "video" ? (
                  <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[0.625rem] font-medium tracking-wider text-sky-300 uppercase">
                    Source
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="flex h-full w-full flex-1 items-center justify-center rounded-md border border-dashed border-white/10 text-xs text-muted-foreground">
                Click a media item to preview, or drag a video onto V1.
              </div>
            )}
          </div>
        </div>

        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-t border-white/5 bg-[#101218] px-3">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!previewUrl || previewKind === "image"}
              title={playing ? "Pause (Space)" : "Play (Space)"}
              onClick={togglePlayback}
            >
              {playing ? (
                <PauseIcon className="size-4 fill-current" />
              ) : (
                <PlayIcon className="size-4 fill-current" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={
                sourcePreview
                  ? !previewUrl || previewKind === "image"
                  : !project || videoClips.length === 0
              }
              title="Go to start"
              onClick={() => {
                if (sourcePreview) {
                  const video = videoRef.current
                  if (video) video.currentTime = 0
                  setSourceTime(0)
                  return
                }
                useVideoEditorStore.getState().setPlayhead(0)
              }}
            >
              <Undo2Icon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!selectedClip || !canSplit}
              title="Split (S)"
              onClick={() => useVideoEditorStore.getState().splitSelectedAtPlayhead()}
            >
              <ScissorsIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={selectedClipIds.length === 0}
              title="Delete (Del)"
              onClick={() => useVideoEditorStore.getState().deleteSelected()}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <span className="min-w-28 font-mono text-xs tabular-nums text-muted-foreground">
              {formatTime(sourcePreview ? sourceTime : playhead)}
              <span className="text-white/30"> / </span>
              {formatTime(
                sourcePreview ? (previewAsset?.durationSeconds ?? 0) : duration,
              )}
            </span>
            <label className="flex items-center gap-2 text-[0.625rem] text-muted-foreground">
              Zoom
              <input
                type="range"
                min={30}
                max={220}
                value={zoom}
                onChange={(event) =>
                  useVideoEditorStore.getState().setZoom(Number(event.target.value))
                }
              />
            </label>
            <label className="flex items-center gap-2 text-[0.625rem] text-muted-foreground">
              Snap
              <input
                type="checkbox"
                checked={snap}
                onChange={(event) =>
                  useVideoEditorStore.getState().setSnap(event.target.checked)
                }
              />
            </label>
          </div>
        </div>
      </main>

      <aside className="col-start-3 row-start-2 flex min-h-0 flex-col border-l border-border bg-card/40">
        <div className="border-b border-border px-3 py-3">
          <p className="text-[0.625rem] font-semibold tracking-wider text-muted-foreground uppercase">
            Inspector
          </p>
          {inspectorAsset ? (
            <div className="mt-2">
              <p className="text-sm font-semibold">{inspectorAsset.label}</p>
              <p className="mt-1 text-[0.625rem] text-muted-foreground">
                {selectedClip
                  ? `${trackById(project, selectedClip.trackId)?.name ?? selectedClip.trackId} · ${formatTime(clipDuration(selectedClip))}`
                  : `Source · ${inspectorAsset.kind} · ${formatTime(inspectorAsset.durationSeconds)}`}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              Click a media item to preview, or select a clip on the timeline.
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {selectedClip && selectedAsset ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-[0.625rem] font-semibold tracking-wider text-muted-foreground uppercase">
                  Clip
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() =>
                    useVideoEditorStore.getState().updateClip(selectedClip.id, (clip) => ({
                      ...clip,
                      muted: !clip.muted,
                    }))
                  }
                >
                  {selectedClip.muted ? "Unmute" : "Mute"}
                </Button>

                <label className="block text-[0.625rem] text-muted-foreground">
                  Volume
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={selectedClip.volume}
                    onChange={(event) => {
                      const value = Number(event.target.value)
                      useVideoEditorStore.getState().updateClip(selectedClip.id, (clip) => ({
                        ...clip,
                        volume: value,
                      }))
                    }}
                    className="mt-2 w-full"
                  />
                </label>
              </div>

              {selectedAsset.kind === "video" ? (
                <div className="space-y-2">
                  <p className="text-[0.625rem] font-semibold tracking-wider text-muted-foreground uppercase">
                    Audio from this video
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() =>
                      useVideoEditorStore.getState().updateClip(selectedClip.id, (clip) => ({
                        ...clip,
                        muteEmbeddedAudio: !clip.muteEmbeddedAudio,
                      }))
                    }
                  >
                    {selectedClip.muteEmbeddedAudio
                      ? "Enable embedded audio"
                      : "Mute embedded audio"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full justify-start"
                    disabled={!selectedAsset.hasEmbeddedAudio || busy}
                    onClick={() => void useVideoEditorStore.getState().detachAudioFromSelected()}
                  >
                    <ArrowLeftRightIcon className="size-4" />
                    Extract audio to timeline
                  </Button>
                </div>
              ) : null}

              {job ? (
                <div className="rounded-lg border border-border bg-background/40 p-3">
                  <p className="text-xs font-semibold">Export</p>
                  <p className="mt-1 text-[0.625rem] text-muted-foreground">
                    {job.stage} · {job.status}
                    {job.percent != null ? ` · ${job.percent.toFixed(0)}%` : ""}
                  </p>
                  {job.status === "running" || job.status === "queued" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-2"
                      onClick={() => void useVideoEditorStore.getState().cancelExport()}
                    >
                      Cancel export
                    </Button>
                  ) : job.status === "completed" && job.resultPath ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      onClick={() => void openPath(job.resultPath!)}
                    >
                      Open export
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </aside>

      <div
        className="col-span-3 row-start-3 h-2 cursor-row-resize border-t border-white/10 bg-[#0b0d11]"
        onPointerDown={(event) => {
          const target = event.currentTarget
          target.setPointerCapture(event.pointerId)
          timelineResizeRef.current = {
            pointerId: event.pointerId,
            originY: event.clientY,
            originHeight: timelineHeight,
          }
        }}
        onPointerMove={(event) => {
          const active = timelineResizeRef.current
          if (!active || active.pointerId !== event.pointerId) return
          const delta = active.originY - event.clientY
          setTimelineHeight(active.originHeight + delta)
        }}
        onPointerUp={(event) => {
          const active = timelineResizeRef.current
          if (!active || active.pointerId !== event.pointerId) return
          timelineResizeRef.current = null
        }}
      />

      <div className="col-span-3 row-start-4 min-h-0">
        <CapcutTimeline />
      </div>

      <EditorExportDialog />
    </div>
  )
}

