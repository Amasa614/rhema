import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { Dialog as DialogPrimitive } from "radix-ui"
import {
  AudioLinesIcon,
  BoldIcon,
  CheckCircle2Icon,
  DownloadIcon,
  FileTextIcon,
  FilmIcon,
  Heading2Icon,
  ItalicIcon,
  ListIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  ScissorsIcon,
  SparklesIcon,
  Trash2Icon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { downloadSermonMarkdown } from "@/lib/sermon-export"
import { VideoEditorWorkspace } from "@/components/post-production/video-editor-workspace"
import { ErrorBoundary } from "@/components/ui/error-boundary"
import { useNotesStore } from "@/stores/notes-store"
import { usePostProductionStore } from "@/stores/postproduction-store"
import { useSettingsStore } from "@/stores/settings-store"
import type {
  CleanvoiceProgress,
  SermonScripture,
  SermonSession,
} from "@/types/postproduction"

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00"
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
}

function sessionAudioLabel(session: SermonSession): string {
  if (session.cleanedAudioPath) return "Cleaned audio"
  if (session.editedAudioPath) return "Trimmed audio"
  return "Raw recording"
}

export function PostProductionWorkspace() {
  const isOpen = usePostProductionStore((state) => state.isOpen)
  const module = usePostProductionStore((state) => state.module)
  const sessions = usePostProductionStore((state) => state.sessions)
  const selectedSessionId = usePostProductionStore(
    (state) => state.selectedSessionId
  )
  const activeRecordingSessionId = usePostProductionStore(
    (state) => state.activeRecordingSessionId
  )
  const activeVideoRecordingId = usePostProductionStore(
    (state) => state.activeVideoRecordingId
  )
  const waveform = usePostProductionStore((state) => state.waveform)
  const audioUrl = usePostProductionStore((state) => state.audioUrl)
  const loading = usePostProductionStore((state) => state.loading)
  const processingStage = usePostProductionStore(
    (state) => state.processingStage
  )
  const error = usePostProductionStore((state) => state.error)
  const cleanvoiceApiKey = useSettingsStore((state) => state.cleanvoiceApiKey)
  const openaiApiKey = useSettingsStore((state) => state.openaiApiKey)
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId]
  )
  const selectedDuration = selectedSession?.durationSeconds ?? 0
  const selectedSummary = selectedSession?.summary ?? ""
  const selectedTitle = selectedSession?.title ?? ""
  const directScriptures =
    selectedSession?.scriptures.filter(
      (scripture) => scripture.source === "ai-direct"
    ) ?? []
  const queuedScriptures =
    selectedSession?.scriptures.filter(
      (scripture) => scripture.source === "queued"
    ) ?? []

  const audioRef = useRef<HTMLAudioElement>(null)
  const summaryTextareaRef = useRef<HTMLTextAreaElement>(null)
  const waveformRef = useRef<HTMLDivElement>(null)
  const dragModeRef = useRef<"select" | "start" | "end" | "playhead" | null>(
    null
  )
  const selectionPlaybackRef = useRef(false)
  const selectionAnchorRef = useRef(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [title, setTitle] = useState("")
  const [summaryDraft, setSummaryDraft] = useState("")
  const [tab, setTab] = useState<"summary" | "transcript" | "scriptures">(
    "summary"
  )

  useEffect(() => {
    if (!isOpen) return
    if (module === "video") {
      void usePostProductionStore.getState().refreshVideos()
      return
    }
    void usePostProductionStore.getState().refresh()
  }, [isOpen, module])

  useEffect(() => {
    if (!selectedSessionId) return
    setTitle(selectedTitle)
  }, [selectedSessionId, selectedTitle])

  useEffect(() => {
    if (!selectedSessionId) return
    setSummaryDraft(selectedSummary)
  }, [selectedSessionId, selectedSummary])

  useEffect(() => {
    if (!selectedSessionId) return
    setTrimStart(0)
    setTrimEnd(selectedDuration)
    setCurrentTime(0)
  }, [selectedDuration, selectedSessionId])

  useEffect(() => {
    const unlistenProgress = listen<CleanvoiceProgress>(
      "cleanvoice_progress",
      ({ payload }) => {
        if (payload.sessionId === selectedSessionId) {
          usePostProductionStore.getState().setProcessingStage(payload.stage)
        }
      }
    )
    const unlistenSaved = listen<SermonSession>(
      "sermon_recording_saved",
      ({ payload }) => {
        usePostProductionStore.getState().upsertSession(payload)
      }
    )
    return () => {
      void unlistenProgress.then((unlisten) => unlisten())
      void unlistenSaved.then((unlisten) => unlisten())
    }
  }, [selectedSessionId])

  const updateSession = useCallback(async (session: SermonSession) => {
    usePostProductionStore.getState().upsertSession(session)
    await usePostProductionStore.getState().selectSession(session.id)
  }, [])

  const saveTitle = async () => {
    if (!selectedSession || !title.trim() || title === selectedSession.title) {
      return
    }
    try {
      const session = await invoke<SermonSession>("rename_sermon_session", {
        sessionId: selectedSession.id,
        title,
      })
      usePostProductionStore.getState().upsertSession(session)
    } catch (saveError) {
      toast.error("Could not rename sermon", {
        description: String(saveError),
      })
    }
  }

  const togglePlayback = async () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      await audio.play()
    } else {
      audio.pause()
    }
  }

  const seekToFraction = (fraction: number) => {
    const audio = audioRef.current
    if (!audio || !waveform) return
    audio.currentTime = fraction * waveform.durationSeconds
    setCurrentTime(audio.currentTime)
  }

  const pointerTime = (clientX: number): number => {
    const waveformElement = waveformRef.current
    if (!waveformElement || !waveform) return 0
    const bounds = waveformElement.getBoundingClientRect()
    const fraction = Math.min(
      1,
      Math.max(0, (clientX - bounds.left) / bounds.width)
    )
    return fraction * waveform.durationSeconds
  }

  const updateDrag = (clientX: number) => {
    const time = pointerTime(clientX)
    const mode = dragModeRef.current
    if (mode === "start") {
      setTrimStart(Math.min(time, trimEnd - 0.05))
      return
    }
    if (mode === "end") {
      setTrimEnd(Math.max(time, trimStart + 0.05))
      return
    }
    if (mode === "playhead") {
      seekToFraction(
        waveform?.durationSeconds ? time / waveform.durationSeconds : 0
      )
      return
    }
    if (mode === "select") {
      setTrimStart(Math.min(selectionAnchorRef.current, time))
      setTrimEnd(Math.max(selectionAnchorRef.current, time))
    }
  }

  const playSelection = async () => {
    const audio = audioRef.current
    if (!audio || selectionDuration <= 0) return
    audio.currentTime = selectionStart
    selectionPlaybackRef.current = true
    setCurrentTime(selectionStart)
    await audio.play()
  }

  const applyTrim = async () => {
    if (!selectedSession || selectionDuration <= 0) return
    usePostProductionStore.getState().setProcessingStage("Saving trim")
    try {
      const session = await invoke<SermonSession>("trim_sermon_audio", {
        sessionId: selectedSession.id,
        startSeconds: selectionStart,
        endSeconds: selectionEnd,
      })
      await updateSession(session)
      toast.success("Trimmed copy saved", {
        description: "The raw recording is preserved.",
      })
    } catch (trimError) {
      toast.error("Could not trim recording", {
        description: String(trimError),
      })
    } finally {
      usePostProductionStore.getState().setProcessingStage(null)
    }
  }

  const cutSelection = async () => {
    if (!selectedSession || selectionDuration <= 0) return
    usePostProductionStore.getState().setProcessingStage("Cutting selection")
    try {
      const session = await invoke<SermonSession>("cut_sermon_audio", {
        sessionId: selectedSession.id,
        startSeconds: selectionStart,
        endSeconds: selectionEnd,
      })
      await updateSession(session)
      toast.success("Selection removed", {
        description:
          "A new edited copy was created; the raw recording is safe.",
      })
    } catch (cutError) {
      toast.error("Could not cut selection", {
        description: String(cutError),
      })
    } finally {
      usePostProductionStore.getState().setProcessingStage(null)
    }
  }

  const processCleanvoice = async (options: {
    cleanAudio: boolean
    transcribe: boolean
    summarize: boolean
  }) => {
    if (!selectedSession) return
    if (!cleanvoiceApiKey) {
      toast.error("Cleanvoice API key required", {
        description: "Add it in Settings → API Keys.",
      })
      return
    }
    usePostProductionStore.getState().setProcessingStage("Preparing upload")
    try {
      const session = await invoke<SermonSession>("process_with_cleanvoice", {
        request: {
          sessionId: selectedSession.id,
          apiKey: cleanvoiceApiKey,
          ...options,
        },
      })
      await updateSession(session)
      toast.success(
        options.summarize
          ? "Transcript and sermon notes are ready"
          : "Cleanvoice processing complete"
      )
    } catch (processError) {
      toast.error("Cleanvoice processing failed", {
        description: String(processError),
      })
    } finally {
      usePostProductionStore.getState().setProcessingStage(null)
    }
  }

  const generateOpenAiSummary = async () => {
    if (!selectedSession) return
    if (!openaiApiKey) {
      toast.error("OpenAI API key required", {
        description: "Add it in Settings → API Keys.",
      })
      return
    }
    if (!selectedSession.transcript.trim()) {
      toast.error("Transcript required", {
        description: "Generate a transcript before creating sermon notes.",
      })
      return
    }
    usePostProductionStore
      .getState()
      .setProcessingStage("Generating sermon notes")
    try {
      const session = await invoke<SermonSession>(
        "generate_openai_sermon_summary",
        {
          request: {
            sessionId: selectedSession.id,
            apiKey: openaiApiKey,
          },
        }
      )
      await updateSession(session)
      setTab("summary")
      toast.success("Sermon notes generated")
    } catch (summaryError) {
      toast.error("Could not generate sermon notes", {
        description: String(summaryError),
      })
    } finally {
      usePostProductionStore.getState().setProcessingStage(null)
    }
  }

  const saveSummaryEdits = async () => {
    if (!selectedSession) return
    try {
      const session = await invoke<SermonSession>("update_sermon_summary", {
        sessionId: selectedSession.id,
        summary: summaryDraft,
      })
      usePostProductionStore.getState().upsertSession(session)
      toast.success("Sermon notes saved")
    } catch (summaryError) {
      toast.error("Could not save sermon notes", {
        description: String(summaryError),
      })
    }
  }

  const formatSummarySelection = (
    prefix: string,
    suffix = prefix,
    placeholder = "text"
  ) => {
    const textarea = summaryTextareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = summaryDraft.slice(start, end) || placeholder
    const replacement = `${prefix}${selected}${suffix}`
    setSummaryDraft(
      `${summaryDraft.slice(0, start)}${replacement}${summaryDraft.slice(end)}`
    )
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(
        start + prefix.length,
        start + prefix.length + selected.length
      )
    })
  }

  const formatSummaryAsList = () => {
    const textarea = summaryTextareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = summaryDraft.slice(start, end) || "List item"
    const replacement = selected
      .split("\n")
      .map((line) => `- ${line}`)
      .join("\n")
    setSummaryDraft(
      `${summaryDraft.slice(0, start)}${replacement}${summaryDraft.slice(end)}`
    )
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(start, start + replacement.length)
    })
  }

  const downloadSermon = async () => {
    if (!selectedSession) return
    try {
      const downloaded = await downloadSermonMarkdown(
        selectedSession,
        summaryDraft
      )
      if (downloaded) toast.success("Sermon downloaded as Markdown")
    } catch (downloadError) {
      toast.error("Could not download sermon", {
        description: String(downloadError),
      })
    }
  }

  const saveAsNote = async () => {
    if (!selectedSession) return
    try {
      if (summaryDraft !== selectedSession.summary) {
        const session = await invoke<SermonSession>("update_sermon_summary", {
          sessionId: selectedSession.id,
          summary: summaryDraft,
        })
        usePostProductionStore.getState().upsertSession(session)
      }
      const note = await invoke<{ title: string; body: string }>(
        "save_sermon_summary_as_note",
        { sessionId: selectedSession.id }
      )
      await useNotesStore.getState().addNote(note)
      toast.success("Sermon summary saved to Notes")
    } catch (noteError) {
      toast.error("Could not save note", { description: String(noteError) })
    }
  }

  const deleteSession = async () => {
    if (!selectedSession) return
    if (
      !globalThis.confirm(
        `Delete “${selectedSession.title}” and all of its audio files?`
      )
    ) {
      return
    }
    try {
      await invoke("delete_sermon_session", {
        sessionId: selectedSession.id,
      })
      usePostProductionStore.getState().clearAudio()
      await usePostProductionStore.getState().refresh()
    } catch (deleteError) {
      toast.error("Could not delete sermon", {
        description: String(deleteError),
      })
    }
  }

  const progress =
    waveform && waveform.durationSeconds > 0
      ? Math.min(1, currentTime / waveform.durationSeconds)
      : 0
  const selectionStart = Math.min(trimStart, trimEnd)
  const selectionEnd = Math.max(trimStart, trimEnd)
  const selectionDuration = Math.max(0, selectionEnd - selectionStart)

  return (
    <DialogPrimitive.Root
      open={isOpen}
      onOpenChange={(open) => usePostProductionStore.getState().setOpen(open)}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background text-foreground outline-none"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">
            Post Production
          </DialogPrimitive.Title>

          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg",
                  module === "video"
                    ? "bg-sky-500/15 text-sky-400"
                    : "bg-lime-500/15 text-lime-400"
                )}
              >
                {module === "video" ? (
                  <FilmIcon className="size-4" />
                ) : (
                  <AudioLinesIcon className="size-4" />
                )}
              </div>
              <div>
                <h1 className="text-base font-semibold">Post Production</h1>
                <p className="text-[0.625rem] text-muted-foreground">
                  {module === "video"
                    ? "Timeline editor for program video"
                    : "Review, polish, transcribe and publish sermons"}
                </p>
              </div>
            </div>
            <div className="flex rounded-lg border border-border p-0.5">
              <button
                type="button"
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  module === "audio"
                    ? "bg-lime-500/15 text-lime-300"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() =>
                  usePostProductionStore.getState().setModule("audio")
                }
              >
                Audio
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  module === "video"
                    ? "bg-sky-500/15 text-sky-300"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() =>
                  usePostProductionStore.getState().setModule("video")
                }
              >
                Video
              </button>
            </div>
            <div className="flex-1" />
            {activeRecordingSessionId || activeVideoRecordingId ? (
              <span className="flex items-center gap-2 rounded-full border border-red-500/25 bg-red-500/10 px-3 py-1 text-xs text-red-300">
                <span className="size-2 animate-pulse rounded-full bg-red-400" />
                Recording in progress
              </span>
            ) : null}
            <Button
              variant="ghost"
              onClick={() => usePostProductionStore.getState().setOpen(false)}
            >
              <XIcon className="size-4" />
              Close
            </Button>
          </header>

          {module === "video" ? (
            <ErrorBoundary
              fallback={(error) => (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
                  <p className="text-sm font-semibold">Video editor crashed</p>
                  <p className="max-w-xl text-xs text-muted-foreground">
                    {String(error)}
                  </p>
                  <Button onClick={() => window.location.reload()}>
                    Reload
                  </Button>
                </div>
              )}
            >
              <VideoEditorWorkspace />
            </ErrorBoundary>
          ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_300px]">
            <aside className="flex min-h-0 flex-col border-r border-border bg-card/50">
              <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
                <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Sermon sessions
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Refresh sessions"
                  onClick={() =>
                    void usePostProductionStore.getState().refresh()
                  }
                >
                  <RefreshCwIcon className="size-3.5" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() =>
                      void usePostProductionStore
                        .getState()
                        .selectSession(session.id)
                    }
                    className={cn(
                      "mb-1 flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                      selectedSessionId === session.id
                        ? "border-lime-500/40 bg-lime-500/10"
                        : "border-transparent hover:bg-muted/60"
                    )}
                  >
                    <span className="line-clamp-2 text-sm font-medium">
                      {session.title}
                    </span>
                    <span className="flex items-center justify-between text-[0.625rem] text-muted-foreground">
                      <span>
                        {new Date(session.createdAt).toLocaleDateString()}
                      </span>
                      <span>{formatDuration(session.durationSeconds)}</span>
                    </span>
                    <span className="flex items-center gap-1 pt-1 text-[0.6rem] text-muted-foreground">
                      {session.cleanedAudioPath ? (
                        <CheckCircle2Icon className="size-3 text-lime-400" />
                      ) : (
                        <AudioLinesIcon className="size-3" />
                      )}
                      {sessionAudioLabel(session)}
                    </span>
                  </button>
                ))}
                {!loading && sessions.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-muted-foreground">
                    <AudioLinesIcon className="size-8 opacity-40" />
                    <p className="text-xs">No recordings yet</p>
                    <p className="text-[0.625rem] leading-relaxed">
                      Sermons are recorded automatically while live
                      transcription is running.
                    </p>
                  </div>
                ) : null}
              </div>
            </aside>

            <main className="flex min-h-0 flex-col">
              {selectedSession ? (
                <>
                  <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
                    <Input
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      onBlur={() => void saveTitle()}
                      className="h-9 max-w-xl border-transparent bg-transparent px-1 text-lg font-semibold shadow-none focus-visible:border-border focus-visible:ring-0"
                    />
                    <div className="flex-1" />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:text-destructive"
                      title="Delete session"
                      onClick={() => void deleteSession()}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>

                  <section className="shrink-0 border-b border-border p-5">
                    <div className="mb-4 flex items-center gap-3">
                      <Button
                        size="icon"
                        className="rounded-full"
                        disabled={!audioUrl}
                        onClick={() => void togglePlayback()}
                      >
                        {isPlaying ? (
                          <PauseIcon className="size-4 fill-current" />
                        ) : (
                          <PlayIcon className="size-4 fill-current" />
                        )}
                      </Button>
                      <div>
                        <p className="text-sm font-medium">
                          {sessionAudioLabel(selectedSession)}
                        </p>
                        <p className="text-[0.625rem] text-muted-foreground">
                          {formatDuration(currentTime)} /{" "}
                          {formatDuration(waveform?.durationSeconds ?? 0)}
                        </p>
                      </div>
                    </div>

                    <div
                      ref={waveformRef}
                      className="relative flex h-36 cursor-crosshair touch-none items-center gap-px overflow-hidden rounded-xl border border-border bg-card px-3 select-none"
                      onPointerDown={(event) => {
                        const time = pointerTime(event.clientX)
                        dragModeRef.current = "select"
                        selectionAnchorRef.current = time
                        selectionPlaybackRef.current = false
                        event.currentTarget.setPointerCapture(event.pointerId)
                        setTrimStart(time)
                        setTrimEnd(time)
                      }}
                      onPointerMove={(event) => {
                        if (dragModeRef.current) updateDrag(event.clientX)
                      }}
                      onPointerUp={(event) => {
                        updateDrag(event.clientX)
                        dragModeRef.current = null
                        event.currentTarget.releasePointerCapture(
                          event.pointerId
                        )
                      }}
                    >
                      {waveform?.peaks.map((peak, index) => {
                        const fraction = index / waveform.peaks.length
                        return (
                          <span
                            key={`${index}-${peak}`}
                            className={cn(
                              "min-w-px flex-1 rounded-full transition-colors",
                              fraction <= progress
                                ? "bg-lime-400"
                                : "bg-muted-foreground/40"
                            )}
                            style={{
                              height: `${Math.max(4, peak * 88)}%`,
                            }}
                          />
                        )
                      })}
                      {waveform?.durationSeconds ? (
                        <>
                          <div
                            className="pointer-events-none absolute inset-y-0 border-x border-sky-300/80 bg-sky-400/20"
                            style={{
                              left: `${(selectionStart / waveform.durationSeconds) * 100}%`,
                              width: `${(selectionDuration / waveform.durationSeconds) * 100}%`,
                            }}
                          />
                          <button
                            type="button"
                            aria-label="Drag selection start"
                            className="absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize border-l-2 border-sky-300"
                            style={{
                              left: `${(selectionStart / waveform.durationSeconds) * 100}%`,
                            }}
                            onPointerDown={(event) => {
                              event.stopPropagation()
                              dragModeRef.current = "start"
                              event.currentTarget.setPointerCapture(
                                event.pointerId
                              )
                            }}
                            onPointerMove={(event) => {
                              if (dragModeRef.current === "start") {
                                updateDrag(event.clientX)
                              }
                            }}
                            onPointerUp={() => {
                              dragModeRef.current = null
                            }}
                          />
                          <button
                            type="button"
                            aria-label="Drag selection end"
                            className="absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize border-r-2 border-sky-300"
                            style={{
                              left: `${(selectionEnd / waveform.durationSeconds) * 100}%`,
                            }}
                            onPointerDown={(event) => {
                              event.stopPropagation()
                              dragModeRef.current = "end"
                              event.currentTarget.setPointerCapture(
                                event.pointerId
                              )
                            }}
                            onPointerMove={(event) => {
                              if (dragModeRef.current === "end") {
                                updateDrag(event.clientX)
                              }
                            }}
                            onPointerUp={() => {
                              dragModeRef.current = null
                            }}
                          />
                          <button
                            type="button"
                            aria-label="Drag playhead"
                            className="absolute inset-y-0 z-30 w-3 -translate-x-1/2 cursor-col-resize border-l-2 border-lime-300"
                            style={{ left: `${progress * 100}%` }}
                            onPointerDown={(event) => {
                              event.stopPropagation()
                              dragModeRef.current = "playhead"
                              event.currentTarget.setPointerCapture(
                                event.pointerId
                              )
                            }}
                            onPointerMove={(event) => {
                              if (dragModeRef.current === "playhead") {
                                updateDrag(event.clientX)
                              }
                            }}
                            onPointerUp={() => {
                              dragModeRef.current = null
                            }}
                          >
                            <span className="absolute top-0 left-[-4px] size-2 rotate-45 bg-lime-300" />
                          </button>
                        </>
                      ) : null}
                      {loading ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-card/80">
                          <LoaderCircleIcon className="size-5 animate-spin text-lime-400" />
                        </div>
                      ) : null}
                    </div>
                    {audioUrl ? (
                      <audio
                        ref={audioRef}
                        src={audioUrl}
                        onTimeUpdate={(event) => {
                          const time = event.currentTarget.currentTime
                          setCurrentTime(time)
                          if (
                            selectionPlaybackRef.current &&
                            time >= selectionEnd
                          ) {
                            selectionPlaybackRef.current = false
                            event.currentTarget.pause()
                            event.currentTarget.currentTime = selectionEnd
                          }
                        }}
                        onPlay={() => setIsPlaying(true)}
                        onPause={() => setIsPlaying(false)}
                        onEnded={() => setIsPlaying(false)}
                      />
                    ) : null}

                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/50 p-3">
                      <div className="mr-auto">
                        <p className="text-[0.625rem] font-medium tracking-wider text-muted-foreground uppercase">
                          Selected audio
                        </p>
                        <p className="font-mono text-xs">
                          {formatDuration(selectionStart)} →{" "}
                          {formatDuration(selectionEnd)} ·{" "}
                          {selectionDuration.toFixed(1)}s
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={selectionDuration <= 0}
                        onClick={() => void playSelection()}
                      >
                        <PlayIcon className="size-3.5 fill-current" />
                        Play selection
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setTrimStart(0)
                          setTrimEnd(waveform?.durationSeconds ?? 0)
                        }}
                      >
                        <RotateCcwIcon className="size-3.5" />
                        Select all
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          Boolean(processingStage) || selectionDuration <= 0
                        }
                        onClick={() => void cutSelection()}
                      >
                        <ScissorsIcon className="size-3.5" />
                        Cut selection
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          Boolean(processingStage) ||
                          selectionDuration <= 0 ||
                          (selectionStart === 0 &&
                            selectionEnd === selectedSession.durationSeconds)
                        }
                        onClick={() => void applyTrim()}
                      >
                        <ScissorsIcon className="size-3.5" />
                        Keep selection
                      </Button>
                    </div>
                  </section>

                  <section className="flex min-h-0 flex-1 flex-col">
                    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-4">
                      {(
                        [
                          ["summary", "Sermon notes", SparklesIcon],
                          ["transcript", "Transcript", FileTextIcon],
                          ["scriptures", "Scriptures", SaveIcon],
                        ] as const
                      ).map(([value, label, Icon]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setTab(value)}
                          className={cn(
                            "flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium",
                            tab === value
                              ? "bg-lime-500/15 text-lime-300"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground"
                          )}
                        >
                          <Icon className="size-3.5" />
                          {label}
                        </button>
                      ))}
                      {tab === "summary" ? (
                        <>
                          <div className="flex-1" />
                          <div className="flex items-center gap-0.5 border-l border-border pl-2">
                            <FormatButton
                              label="Bold"
                              onClick={() =>
                                formatSummarySelection("**", "**", "bold text")
                              }
                            >
                              <BoldIcon className="size-3.5" />
                            </FormatButton>
                            <FormatButton
                              label="Italic"
                              onClick={() =>
                                formatSummarySelection("*", "*", "italic text")
                              }
                            >
                              <ItalicIcon className="size-3.5" />
                            </FormatButton>
                            <FormatButton
                              label="Heading"
                              onClick={() =>
                                formatSummarySelection(
                                  "## ",
                                  "",
                                  "Section heading"
                                )
                              }
                            >
                              <Heading2Icon className="size-3.5" />
                            </FormatButton>
                            <FormatButton
                              label="Bulleted list"
                              onClick={formatSummaryAsList}
                            >
                              <ListIcon className="size-3.5" />
                            </FormatButton>
                          </div>
                          {summaryDraft !== selectedSession.summary ? (
                            <Button
                              type="button"
                              size="sm"
                              className="ml-2 h-8"
                              onClick={() => void saveSummaryEdits()}
                            >
                              <SaveIcon className="size-3.5" />
                              Save
                            </Button>
                          ) : (
                            <span
                              className="ml-2 flex items-center gap-1 text-[0.625rem] text-muted-foreground"
                              title="All changes saved"
                            >
                              <CheckCircle2Icon className="size-3.5 text-lime-400" />
                              Saved
                            </span>
                          )}
                        </>
                      ) : null}
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-5">
                      {tab === "summary" ? (
                        <div className="flex h-full min-h-80 flex-col">
                          <Textarea
                            ref={summaryTextareaRef}
                            value={summaryDraft}
                            onChange={(event) =>
                              setSummaryDraft(event.target.value)
                            }
                            placeholder="Generate sermon notes with OpenAI or write your own notes here..."
                            className="min-h-72 flex-1 resize-none bg-card/60 font-sans text-sm leading-7"
                          />
                        </div>
                      ) : null}
                      {tab === "transcript" ? (
                        selectedSession.transcript ? (
                          <Textarea
                            readOnly
                            value={selectedSession.transcript}
                            className="min-h-full resize-none border-none bg-transparent text-sm leading-7 shadow-none focus-visible:ring-0"
                          />
                        ) : (
                          <EmptyCopy text="No transcript has been generated yet. The rough live transcript is archived while recording." />
                        )
                      ) : null}
                      {tab === "scriptures" ? (
                        directScriptures.length > 0 ||
                        queuedScriptures.length > 0 ? (
                          <div className="space-y-6">
                            <ScriptureGroup
                              title="Direct AI hits"
                              description="Explicit book, chapter and verse references heard in the sermon."
                              scriptures={directScriptures}
                              accent="lime"
                            />
                            <ScriptureGroup
                              title="Queued / manually added"
                              description="Scriptures intentionally placed in the service queue."
                              scriptures={queuedScriptures}
                              accent="sky"
                            />
                          </div>
                        ) : (
                          <EmptyCopy text="Only explicit AI references and scriptures placed in the queue will appear here." />
                        )
                      ) : null}
                    </div>
                  </section>
                </>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
                  <AudioLinesIcon className="size-10 opacity-40" />
                  <p className="text-sm">Select a sermon recording</p>
                </div>
              )}
            </main>

            <aside className="min-h-0 overflow-y-auto border-l border-border bg-card/50 p-3">
              <div className="mb-3">
                <h2 className="text-sm font-semibold">Post-production</h2>
                <p className="text-[0.625rem] text-muted-foreground">
                  Clean, transcribe, then create notes.
                </p>
              </div>

              {processingStage ? (
                <div className="mb-4 flex items-center gap-3 rounded-lg border border-lime-500/30 bg-lime-500/10 p-3">
                  <LoaderCircleIcon className="size-4 animate-spin text-lime-400" />
                  <div>
                    <p className="text-xs font-medium">Processing sermon</p>
                    <p className="text-[0.625rem] text-muted-foreground">
                      {processingStage}
                    </p>
                  </div>
                </div>
              ) : null}

              <div className="overflow-hidden rounded-xl border border-border bg-background">
                <ProcessingAction
                  icon={WandSparklesIcon}
                  title="Clean audio"
                  description="Noise, pauses and filler words"
                  action="Run"
                  disabled={!selectedSession || Boolean(processingStage)}
                  onClick={() =>
                    void processCleanvoice({
                      cleanAudio: true,
                      transcribe: false,
                      summarize: false,
                    })
                  }
                />
                <ProcessingAction
                  icon={FileTextIcon}
                  title="Transcript"
                  description="Create a polished transcript"
                  action="Run"
                  disabled={!selectedSession || Boolean(processingStage)}
                  onClick={() =>
                    void processCleanvoice({
                      cleanAudio: false,
                      transcribe: true,
                      summarize: false,
                    })
                  }
                />
                <ProcessingAction
                  icon={SparklesIcon}
                  title="Sermon notes"
                  description="Generate structured notes"
                  action={selectedSession?.summary ? "Regenerate" : "Generate"}
                  disabled={
                    !selectedSession?.transcript.trim() ||
                    Boolean(processingStage)
                  }
                  onClick={() => void generateOpenAiSummary()}
                />
              </div>

              <div className="mt-4">
                <p className="mb-2 text-[0.625rem] font-medium tracking-wider text-muted-foreground uppercase">
                  Export
                </p>
                <div className="overflow-hidden rounded-xl border border-border bg-background">
                  <Button
                    variant="ghost"
                    className="h-11 w-full justify-start rounded-none px-3"
                    disabled={!summaryDraft.trim()}
                    onClick={() => void saveAsNote()}
                  >
                    <SaveIcon className="size-4" />
                    Save to Notes
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-11 w-full justify-start rounded-none border-t border-border px-3"
                    disabled={
                      !summaryDraft.trim() &&
                      !selectedSession?.transcript.trim()
                    }
                    onClick={() => void downloadSermon()}
                  >
                    <DownloadIcon className="size-4" />
                    Download sermon
                  </Button>
                </div>
                <p className="mt-2 text-center text-[0.6rem] text-muted-foreground">
                  Notes, scriptures and transcript
                </p>
              </div>

              {error ? (
                <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </aside>
          </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function EmptyCopy({ text }: { text: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-center text-muted-foreground">
      <FileTextIcon className="size-7 opacity-40" />
      <p className="max-w-sm text-xs leading-relaxed">{text}</p>
    </div>
  )
}

function FormatButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground hover:bg-muted hover:text-foreground"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

function ScriptureGroup({
  accent,
  description,
  scriptures,
  title,
}: {
  accent: "lime" | "sky"
  description: string
  scriptures: SermonScripture[]
  title: string
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span
          className={cn(
            "size-2 rounded-full",
            accent === "lime" ? "bg-lime-400" : "bg-sky-400"
          )}
        />
        <div>
          <h3 className="text-xs font-semibold">{title}</h3>
          <p className="text-[0.625rem] text-muted-foreground">{description}</p>
        </div>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[0.625rem] font-medium">
          {scriptures.length}
        </span>
      </div>
      {scriptures.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {scriptures.map((scripture) => (
            <div
              key={`${scripture.source}-${scripture.reference}`}
              className="rounded-lg border border-border bg-card p-3 text-sm font-medium"
            >
              {scripture.reference}
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          None captured.
        </p>
      )}
    </section>
  )
}

function ProcessingAction({
  action,
  description,
  disabled,
  icon: Icon,
  onClick,
  title,
}: {
  action: string
  description: string
  disabled: boolean
  icon: typeof SparklesIcon
  onClick: () => void
  title: string
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border p-3 last:border-b-0">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-xs font-medium">{title}</h3>
        <p className="truncate text-[0.625rem] text-muted-foreground">
          {description}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 px-2 text-xs text-lime-300 hover:text-lime-200"
        disabled={disabled}
        onClick={onClick}
      >
        {action}
      </Button>
    </div>
  )
}
