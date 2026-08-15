import { useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { open } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import {
  AudioLinesIcon,
  FolderOpenIcon,
  ImageIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScissorsIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SparklesIcon,
  SquareSplitHorizontalIcon,
  Trash2Icon,
  VideoIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { usePostProductionStore } from "@/stores/postproduction-store"
import { useSettingsStore } from "@/stores/settings-store"
import type { ExtractedAudio, VideoRecording } from "@/types/stream"
import {
  EditorTimeline,
  formatTimecode,
} from "@/components/post-production/video-editor-timeline"

export function VideoPostProductionPanel() {
  const recordings = usePostProductionStore((state) => state.videoRecordings)
  const selectedVideoId = usePostProductionStore((state) => state.selectedVideoId)
  const activeVideoRecordingId = usePostProductionStore(
    (state) => state.activeVideoRecordingId,
  )
  const videoUrl = usePostProductionStore((state) => state.videoUrl)
  const loading = usePostProductionStore((state) => state.videoLoading)
  const error = usePostProductionStore((state) => state.videoError)
  const cleanvoiceApiKey = useSettingsStore((state) => state.cleanvoiceApiKey)
  const selected = useMemo(
    () => recordings.find((recording) => recording.id === selectedVideoId) ?? null,
    [recordings, selectedVideoId],
  )
  const [title, setTitle] = useState("")
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const isLiveFile = selected?.id === activeVideoRecordingId
  const canEdit = Boolean(selected && videoUrl && !isLiveFile && !busy)
  const selectionStart = Math.min(trimStart, trimEnd)
  const selectionEnd = Math.max(trimStart, trimEnd)
  const selectionDuration = Math.max(0, selectionEnd - selectionStart)

  useEffect(() => {
    setTitle(selected?.title ?? "")
    setCurrentTime(0)
    setDuration(selected?.durationSeconds ?? 0)
    setTrimStart(0)
    setTrimEnd(selected?.durationSeconds ?? 0)
    setPlaying(false)
  }, [selected?.id, selected?.title, selected?.durationSeconds])

  useEffect(() => {
    const unlisten = listen<{ recordingId?: string; stage?: string }>(
      "video_edit_progress",
      (event) => {
        if (event.payload.recordingId === selectedVideoId) {
          setStage(event.payload.stage ?? "Working")
        }
      },
    )
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [selectedVideoId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return
      }
      if (!canEdit) return
      if (event.code === "Space") {
        event.preventDefault()
        const video = videoRef.current
        if (!video) return
        if (video.paused) void video.play()
        else video.pause()
        return
      }
      if (event.key === "i" || event.key === "I") {
        setTrimStart(videoRef.current?.currentTime ?? currentTime)
        return
      }
      if (event.key === "o" || event.key === "O") {
        setTrimEnd(videoRef.current?.currentTime ?? currentTime)
        return
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        const step = event.shiftKey ? 5 : 1
        const next = Math.max(0, (videoRef.current?.currentTime ?? 0) - step)
        if (videoRef.current) videoRef.current.currentTime = next
        setCurrentTime(next)
      }
      if (event.key === "ArrowRight") {
        event.preventDefault()
        const step = event.shiftKey ? 5 : 1
        const next = Math.min(duration, (videoRef.current?.currentTime ?? 0) + step)
        if (videoRef.current) videoRef.current.currentTime = next
        setCurrentTime(next)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [canEdit, duration])

  const saveTitle = async () => {
    if (!selected || !title.trim() || title === selected.title) return
    try {
      const recording = await invoke<VideoRecording>("rename_video_recording", {
        recordingId: selected.id,
        title,
      })
      usePostProductionStore.getState().upsertVideo(recording)
    } catch (saveError) {
      toast.error("Could not rename video", {
        description: String(saveError),
      })
    }
  }

  const deleteRecording = async () => {
    if (!selected) return
    if (!globalThis.confirm(`Delete “${selected.title}” and its video file?`)) {
      return
    }
    try {
      await invoke("delete_video_recording", {
        recordingId: selected.id,
      })
      await usePostProductionStore.getState().refreshVideos()
    } catch (deleteError) {
      toast.error("Could not delete video", {
        description: String(deleteError),
      })
    }
  }

  const seekTo = (time: number) => {
    const video = videoRef.current
    const next = Math.min(duration, Math.max(0, time))
    if (video) video.currentTime = next
    setCurrentTime(next)
  }

  const togglePlayback = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }

  const runEdit = async (label: string, work: () => Promise<VideoRecording>) => {
    if (!selected) return
    setBusy(true)
    setStage(label)
    try {
      const recording = await work()
      const store = usePostProductionStore.getState()
      store.upsertVideo(recording)
      store.selectVideo(recording.id)
      toast.success("Saved a new video", { description: recording.title })
    } catch (editError) {
      toast.error("Could not edit video", {
        description: String(editError),
      })
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  const pickAudio = async () =>
    open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "aac"] }],
    })

  const pickImage = async () =>
    open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    })

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto]">
      <div className="grid min-h-0 grid-cols-[220px_minmax(0,1fr)_280px]">
        <aside className="flex min-h-0 flex-col border-r border-border bg-card/40">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="text-[0.625rem] font-semibold tracking-wider text-muted-foreground uppercase">
              Media
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              title="Refresh videos"
              onClick={() => {
                void usePostProductionStore.getState().refreshVideos()
              }}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {recordings.map((recording) => (
              <button
                key={recording.id}
                type="button"
                onClick={() =>
                  usePostProductionStore.getState().selectVideo(recording.id)
                }
                className={cn(
                  "mb-1 flex w-full gap-2 rounded-md border p-2 text-left transition-colors",
                  selectedVideoId === recording.id
                    ? "border-sky-500/40 bg-sky-500/10"
                    : "border-transparent hover:bg-muted/60",
                )}
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded bg-sky-500/15 text-sky-300">
                  <VideoIcon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-xs font-medium">
                    {recording.title}
                  </span>
                  <span className="text-[0.5625rem] text-muted-foreground">
                    {recording.id === activeVideoRecordingId
                      ? "Recording"
                      : formatTimecode(recording.durationSeconds)}
                  </span>
                </span>
              </button>
            ))}
            {recordings.length === 0 && !loading ? (
              <p className="px-2 py-6 text-center text-[0.625rem] text-muted-foreground">
                Record or Go live. Clips land here when you stop.
              </p>
            ) : null}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col bg-black">
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            {isLiveFile ? (
              <div className="flex aspect-video max-h-full w-full max-w-4xl items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-300">
                Recording in progress. Stop to load the file.
              </div>
            ) : videoUrl ? (
              <video
                ref={videoRef}
                key={selected?.id}
                src={videoUrl}
                playsInline
                className="max-h-full max-w-full rounded-md bg-black object-contain shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onLoadedMetadata={(event) => {
                  const next = event.currentTarget.duration
                  if (Number.isFinite(next) && next > 0) {
                    setDuration(next)
                    setTrimEnd(next)
                  }
                }}
                onTimeUpdate={(event) => {
                  setCurrentTime(event.currentTarget.currentTime)
                }}
              />
            ) : selected ? (
              <div className="flex aspect-video max-h-full w-full max-w-4xl items-center justify-center rounded-lg border border-dashed border-white/10 text-xs text-muted-foreground">
                Could not open this video file.
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-center text-muted-foreground">
                <VideoIcon className="size-8 opacity-40" />
                <p className="max-w-sm text-xs leading-relaxed">
                  Select a clip from Media, or record from the top bar.
                </p>
              </div>
            )}
          </div>
          <div className="flex h-12 shrink-0 items-center justify-center gap-1 border-t border-white/5 bg-[#101218] px-3">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!canEdit}
              title="Go to in"
              onClick={() => seekTo(selectionStart)}
            >
              <SkipBackIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!videoUrl || isLiveFile}
              title={playing ? "Pause" : "Play (Space)"}
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
              disabled={!canEdit}
              title="Go to out"
              onClick={() => seekTo(selectionEnd)}
            >
              <SkipForwardIcon className="size-4" />
            </Button>
            <span className="ml-3 min-w-28 font-mono text-xs tabular-nums text-muted-foreground">
              {formatTimecode(currentTime)}
              <span className="text-white/30"> / </span>
              {formatTimecode(duration)}
            </span>
            {stage ? (
              <span className="ml-3 text-[0.625rem] text-sky-400">{stage}</span>
            ) : null}
          </div>
        </section>

        <aside className="flex min-h-0 flex-col border-l border-border bg-card/40">
          <div className="border-b border-border px-3 py-2">
            <Input
              value={title}
              disabled={!selected}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                void saveTitle()
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur()
              }}
              className="h-8 border-0 bg-transparent px-0 text-sm font-semibold shadow-none focus-visible:ring-0"
              placeholder="Clip name"
            />
            <p className="text-[0.5625rem] text-muted-foreground">
              In {formatTimecode(selectionStart)} · Out{" "}
              {formatTimecode(selectionEnd)} · {selectionDuration.toFixed(1)}s
            </p>
            <p className="mt-1 text-[0.5625rem] text-muted-foreground">
              I / O mark in-out · Space play · arrows scrub
            </p>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
            <p className="px-1 pt-1 text-[0.5625rem] font-semibold tracking-wider text-muted-foreground uppercase">
              Timeline
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={!canEdit}
              onClick={() => setTrimStart(currentTime)}
            >
              Mark in
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={!canEdit}
              onClick={() => setTrimEnd(currentTime)}
            >
              Mark out
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={!canEdit}
              onClick={() => {
                setTrimStart(0)
                setTrimEnd(duration)
              }}
            >
              <RotateCcwIcon />
              Select all
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              disabled={!canEdit || selectionDuration <= 0.05}
              onClick={() => {
                void runEdit("Keeping selection", () =>
                  invoke<VideoRecording>("video_keep_range", {
                    recordingId: selected?.id,
                    range: {
                      startSeconds: selectionStart,
                      endSeconds: selectionEnd,
                    },
                  }),
                )
              }}
            >
              <ScissorsIcon />
              Keep in–out
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              disabled={
                !canEdit ||
                selectionDuration <= 0.05 ||
                (selectionStart <= 0.05 && selectionEnd >= duration - 0.05)
              }
              onClick={() => {
                void runEdit("Cutting selection", () =>
                  invoke<VideoRecording>("video_cut_range", {
                    recordingId: selected?.id,
                    range: {
                      startSeconds: selectionStart,
                      endSeconds: selectionEnd,
                    },
                  }),
                )
              }}
            >
              <SquareSplitHorizontalIcon />
              Cut in–out
            </Button>
            <p className="px-1 pt-3 text-[0.5625rem] font-semibold tracking-wider text-muted-foreground uppercase">
              Audio
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={!canEdit}
              onClick={() => {
                if (!selected) return
                setBusy(true)
                setStage("Extracting audio")
                void invoke<ExtractedAudio>("video_extract_audio", {
                  recordingId: selected.id,
                })
                  .then((result) => {
                    toast.success("Audio extracted", {
                      description: result.audioPath,
                    })
                  })
                  .catch((extractError) => {
                    toast.error("Could not extract audio", {
                      description: String(extractError),
                    })
                  })
                  .finally(() => {
                    setBusy(false)
                    setStage(null)
                  })
              }}
            >
              <AudioLinesIcon />
              Separate audio
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={!canEdit}
              onClick={() => {
                void pickAudio().then((path) => {
                  if (!path || typeof path !== "string" || !selected) return
                  void runEdit("Replacing audio", () =>
                    invoke<VideoRecording>("video_replace_audio", {
                      recordingId: selected.id,
                      audioPath: path,
                      mix: false,
                    }),
                  )
                })
              }}
            >
              <AudioLinesIcon />
              Replace audio
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={!canEdit}
              onClick={() => {
                void pickAudio().then((path) => {
                  if (!path || typeof path !== "string" || !selected) return
                  void runEdit("Mixing audio", () =>
                    invoke<VideoRecording>("video_replace_audio", {
                      recordingId: selected.id,
                      audioPath: path,
                      mix: true,
                    }),
                  )
                })
              }}
            >
              <AudioLinesIcon />
              Mix in audio
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={!canEdit || !cleanvoiceApiKey}
              title={
                cleanvoiceApiKey
                  ? "Clean room noise, then mux it back"
                  : "Add a Cleanvoice key in Settings first"
              }
              onClick={() => {
                if (!selected || !cleanvoiceApiKey) return
                void runEdit("Cleaning audio", () =>
                  invoke<VideoRecording>("video_clean_audio", {
                    recordingId: selected.id,
                    apiKey: cleanvoiceApiKey,
                  }),
                )
              }}
            >
              <SparklesIcon />
              Clean noise
            </Button>
            <p className="px-1 pt-3 text-[0.5625rem] font-semibold tracking-wider text-muted-foreground uppercase">
              Overlay
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={!canEdit}
              onClick={() => {
                void pickImage().then((path) => {
                  if (!path || typeof path !== "string" || !selected) return
                  void runEdit("Adding overlay", () =>
                    invoke<VideoRecording>("video_overlay_image", {
                      recordingId: selected.id,
                      imagePath: path,
                    }),
                  )
                })
              }}
            >
              <ImageIcon />
              Overlay image
            </Button>
            <div className="mt-auto flex flex-col gap-1 border-t border-border pt-2">
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                disabled={!selected}
                onClick={() => {
                  void invoke("open_video_recordings_folder").catch(
                    (openError) => {
                      toast.error("Could not open recordings folder", {
                        description: String(openError),
                      })
                    },
                  )
                }}
              >
                <FolderOpenIcon />
                Open folder
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start text-destructive hover:text-destructive"
                disabled={!selected || isLiveFile || busy}
                onClick={() => {
                  void deleteRecording()
                }}
              >
                <Trash2Icon />
                Delete clip
              </Button>
            </div>
            {error ? (
              <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-[0.625rem] text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </aside>
      </div>

      <div className="flex h-[220px] shrink-0 flex-col border-t border-white/10">
        <div className="flex h-8 items-center gap-2 border-b border-white/5 bg-[#101218] px-3 text-[0.625rem] text-muted-foreground">
          <span className="font-semibold tracking-wider uppercase">Timeline</span>
          <span>Drag the amber handles for in/out. Drag the playhead to scrub.</span>
        </div>
        {selected && videoUrl && !isLiveFile ? (
          <EditorTimeline
            duration={duration}
            currentTime={currentTime}
            trimStart={selectionStart}
            trimEnd={selectionEnd}
            clipLabel={selected.title}
            onSeek={seekTo}
            onChangeRange={(start, end) => {
              setTrimStart(start)
              setTrimEnd(end)
            }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center bg-[#0c0e12] text-xs text-muted-foreground">
            Load a clip to edit on the timeline
          </div>
        )}
      </div>
    </div>
  )
}
