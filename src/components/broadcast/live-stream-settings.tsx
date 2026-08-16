import { useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { emitTo, listen } from "@tauri-apps/api/event"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ProgramLookSwitch } from "@/components/controls/program-look-switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { programLookUsesCamera } from "@/lib/program-look"
import { waitForBroadcastOutputReady } from "@/lib/broadcast-lifecycle"
import {
  armOnActivationKey,
  useArmedCommit,
} from "@/lib/user-armed-commit"
import { redactRtmpSecrets } from "@/lib/stream-secrets"
import { useSettingsStore } from "@/stores/settings-store"
import { usePostProductionStore } from "@/stores/postproduction-store"
import {
  emitProgramLook,
  emitProjectorCamera,
  useStreamSessionStore,
} from "@/stores/stream-session-store"
import type {
  DshowDevices,
  StreamDestinationPreset,
  StreamStartPayload,
  StreamStatus,
  VideoRecording,
} from "@/types/stream"
import { CircleIcon, FolderOpenIcon, RadioIcon, RefreshCwIcon } from "lucide-react"

const NONE = "none"

const PRESETS: Record<
  StreamDestinationPreset,
  { label: string; url: string }
> = {
  youtube: {
    label: "YouTube Live",
    url: "rtmps://a.rtmps.youtube.com/live2",
  },
  facebook: {
    label: "Facebook Live",
    url: "rtmps://rtmp-api.facebook.com:443/rtmp/",
  },
  custom: { label: "Custom RTMP / Restream", url: "" },
}

function isPhoneVirtualCam(name: string): boolean {
  return /camo|iriun/i.test(name)
}

function matchingPhoneAudio(videoName: string, audioDevices: string[]): string {
  if (!isPhoneVirtualCam(videoName)) return ""
  return audioDevices.find((name) => isPhoneVirtualCam(name)) ?? ""
}

let cachedDevices: DshowDevices = { video: [], audio: [] }

async function waitForOverlayReady(
  outputId: "main",
  active: boolean,
  timeoutMs = 2500,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let done = false
    let unlisten: (() => void) | null = null
    const cleanup = () => {
      if (unlisten) unlisten()
    }
    const timer = globalThis.setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      reject(new Error("Overlay did not become ready in time."))
    }, timeoutMs)

    void listen<{ outputId: string; active?: boolean }>(
      "broadcast:stream-overlay-ready",
      (event) => {
        if (done) return
        if (event.payload.outputId !== outputId) return
        if (Boolean(event.payload.active) !== active) return
        done = true
        clearTimeout(timer)
        cleanup()
        resolve()
      },
    ).then((fn) => {
      if (done) fn()
      else unlisten = fn
    })
  })
}

export function LiveStreamSettings({ className }: { className?: string }) {
  const preset = useSettingsStore((s) => s.streamPreset)
  const serverUrl = useSettingsStore((s) => s.streamServerUrl)
  const streamKey = useSettingsStore((s) => s.streamKey)
  const videoDevice = useSettingsStore((s) => s.streamVideoDevice)
  const audioDevice = useSettingsStore((s) => s.streamAudioDevice)
  const includeOverlay = useSettingsStore((s) => s.streamIncludeOverlay)
  const showOnProjector = useSettingsStore((s) => s.streamShowOnProjector)
  const programLook = useSettingsStore((s) => s.streamProgramLook)
  const setPreset = useSettingsStore((s) => s.setStreamPreset)
  const setServerUrl = useSettingsStore((s) => s.setStreamServerUrl)
  const setStreamKey = useSettingsStore((s) => s.setStreamKey)
  const setVideoDevice = useSettingsStore((s) => s.setStreamVideoDevice)
  const setAudioDevice = useSettingsStore((s) => s.setStreamAudioDevice)
  const setIncludeOverlay = useSettingsStore((s) => s.setStreamIncludeOverlay)
  const setProgramLook = useSettingsStore((s) => s.setStreamProgramLook)

  const [devices, setDevices] = useState<DshowDevices>(cachedDevices)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [recordings, setRecordings] = useState<VideoRecording[]>([])
  const activeVideoRecordingId = usePostProductionStore(
    (state) => state.activeVideoRecordingId,
  )
  const live = useStreamSessionStore((state) => state.live)
  const pendingRecord = useStreamSessionStore((state) => state.pendingRecord)
  const ffmpegPath = useStreamSessionStore((state) => state.ffmpegPath)
  const lastError = useStreamSessionStore((state) => state.lastError)
  const statusReady = useStreamSessionStore((state) => state.statusReady)
  const recording = pendingRecord || Boolean(activeVideoRecordingId)

  const refresh = useCallback(async (): Promise<DshowDevices> => {
    setRefreshing(true)
    try {
      const [nextStatus, nextDevices] = await Promise.all([
        invoke<StreamStatus>("stream_status"),
        invoke<DshowDevices>("stream_list_devices").catch(() => ({
          video: [] as string[],
          audio: [] as string[],
        })),
      ])
      useStreamSessionStore.getState().applyStatus(nextStatus)
      cachedDevices = nextDevices
      setDevices(nextDevices)
      const current = useSettingsStore.getState().streamVideoDevice
      const currentAudio = useSettingsStore.getState().streamAudioDevice
      const phone = nextDevices.video.find(isPhoneVirtualCam)
      if (phone && !current) {
        setVideoDevice(phone)
      }
      const selectedVideo = current || phone || ""
      const phoneMic = matchingPhoneAudio(selectedVideo, nextDevices.audio)
      if (phoneMic && !currentAudio) {
        setAudioDevice(phoneMic)
      }
      return nextDevices
    } catch (error) {
      useStreamSessionStore.getState().applyStatus({
        active: false,
        ffmpegPath: null,
        lastError: String(error),
      })
      return { video: [], audio: [] }
    } finally {
      setRefreshing(false)
    }
  }, [setAudioDevice, setVideoDevice])

  useEffect(() => {
    const unlisten = listen<{ error?: string }>("broadcast:camera-error", (event) => {
      toast.error("Could not open camera on the projector", {
        description: event.payload.error ?? "Allow camera access if Windows asks.",
      })
      setProgramLook("slides")
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [setProgramLook])

  useEffect(() => {
    void invoke<VideoRecording[]>("list_video_recordings")
      .then(setRecordings)
      .catch(() => {})
  }, [])

  useEffect(() => {
    const settings = useSettingsStore.getState()
    if (cachedDevices.video.length === 0 && cachedDevices.audio.length === 0) {
      const cameraInUse =
        programLookUsesCamera(settings.streamProgramLook) ||
        Boolean(usePostProductionStore.getState().activeVideoRecordingId)
      if (cameraInUse && settings.streamVideoDevice) {
        cachedDevices = {
          video: [settings.streamVideoDevice],
          audio: settings.streamAudioDevice ? [settings.streamAudioDevice] : [],
        }
        setDevices(cachedDevices)
      } else if (!cameraInUse) {
        void refresh()
      }
    }
  }, [refresh])

  const handlePreset = (value: StreamDestinationPreset) => {
    setPreset(value)
    if (value !== "custom") {
      setServerUrl(PRESETS[value].url)
    }
  }

  const handleGoLive = async () => {
    setBusy(true)
    try {
      if (recording) {
        await emitTo("broadcast", "broadcast:record", { active: false })
        useStreamSessionStore.getState().setPendingRecord(false)
      }
      await invoke("ensure_broadcast_window", { outputId: "main" })
      await waitForBroadcastOutputReady("main")
      await useStreamSessionStore.getState().setProgramLook(programLook)
      await emitTo("broadcast", "broadcast:stream-overlay", { active: true })
      await waitForOverlayReady("main", true).catch(() => {})
      await new Promise((resolve) => globalThis.setTimeout(resolve, 400))
      const ingestUrl =
        preset === "custom" ? serverUrl : PRESETS[preset].url
      const payload: StreamStartPayload = {
        serverUrl: ingestUrl,
        streamKey,
        videoDevice: videoDevice || null,
        audioDevice: audioDevice || null,
        includeOverlay: true,
        width: 1920,
        height: 1080,
        fps: 30,
        videoBitrateKbps: 4500,
        recordLocal: false,
      }
      const next = await invoke<StreamStatus>("stream_start", { payload })
      useStreamSessionStore.getState().applyStatus(next)
      toast.success("Live stream started")
      void invoke<VideoRecording[]>("list_video_recordings").then(setRecordings).catch(() => {})
    } catch (error) {
      const message = redactRtmpSecrets(String(error), streamKey)
      useStreamSessionStore.getState().applyStatus({
        active: false,
        ffmpegPath: useStreamSessionStore.getState().ffmpegPath,
        lastError: message,
      })
      toast.error("Could not start live stream", {
        description: message,
      })
      void emitTo("broadcast", "broadcast:stream-overlay", { active: false })
      if (videoDevice && (programLookUsesCamera(programLook) || showOnProjector)) {
        emitProjectorCamera(true, videoDevice)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async () => {
    setBusy(true)
    try {
      const next = await invoke<StreamStatus>("stream_stop")
      useStreamSessionStore.getState().applyStatus(next)
      void emitTo("broadcast", "broadcast:stream-overlay", { active: false })
      if (videoDevice && (programLookUsesCamera(programLook) || showOnProjector)) {
        emitProjectorCamera(true, videoDevice)
      }
      toast.success("Live stream stopped", {
        description: "The local video is in Post Production → Video.",
        action: {
          label: "Open",
          onClick: () => {
            usePostProductionStore.getState().openModule("video")
          },
        },
      })
      void invoke<VideoRecording[]>("list_video_recordings").then(setRecordings).catch(() => {})
    } catch (error) {
      toast.error("Could not stop live stream", {
        description: redactRtmpSecrets(String(error), streamKey),
      })
    } finally {
      setBusy(false)
    }
  }

  const ffmpegMissing = statusReady && !ffmpegPath
  const phoneCam = devices.video.find(isPhoneVirtualCam)

  const overlaySwitch = useArmedCommit((include: boolean) => {
    setIncludeOverlay(include)
  })
  const cameraSelect = useArmedCommit((value: string) => {
    const next = value === NONE ? "" : value
    setVideoDevice(next)
    const look = useSettingsStore.getState().streamProgramLook
    if (programLookUsesCamera(look)) {
      if (next) {
        emitProgramLook(look, next)
      } else {
        void useStreamSessionStore.getState().setProgramLook("slides")
      }
    }
    const phoneMic = matchingPhoneAudio(next, devices.audio)
    if (phoneMic && !useSettingsStore.getState().streamAudioDevice) {
      setAudioDevice(phoneMic)
    }
  })
  const audioSelect = useArmedCommit((value: string) => {
    setAudioDevice(value === NONE ? "" : value)
  })

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-4 space-y-3",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <RadioIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">Live stream</span>
          <span
            className={cn(
              "text-xs",
              live ? "text-emerald-400" : "text-muted-foreground",
            )}
          >
            {live ? "On air" : "Not streaming"}
          </span>
          {programLook !== "slides" ? (
            <span className="text-xs text-sky-400">
              {programLook === "camera" ? "Camera" : "Mix"}
            </span>
          ) : null}
          {recording ? (
            <span className="text-xs text-red-400">Recording</span>
          ) : null}
        </div>
        <p className="hidden sm:block text-[0.65rem] text-muted-foreground truncate">
          Camera, Slides, and Mix all go out on the livestream.
        </p>
      </div>

      {ffmpegMissing ? (
        <p className="text-xs text-amber-400">
          FFmpeg not found. Install with <code>winget install FFmpeg</code> or
          set FFMPEG_PATH.
        </p>
      ) : null}
      {lastError ? (
        <p className="text-xs text-destructive">{lastError}</p>
      ) : null}
      {phoneCam ? (
        <p className="text-xs text-emerald-400">Phone camera: {phoneCam}</p>
      ) : devices.video.length === 0 ? (
        <p className="text-xs text-amber-400">
          No cameras listed yet. Click Refresh — Iriun should appear as Iriun
          Webcam.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Destination</label>
            <Select
              value={preset}
              onValueChange={(value) =>
                handlePreset(value as StreamDestinationPreset)
              }
              disabled={live}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PRESETS) as StreamDestinationPreset[]).map(
                  (key) => (
                    <SelectItem key={key} value={key}>
                      {PRESETS[key].label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
          {preset === "custom" ? (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Server URL</label>
              <Input
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="rtmps://…"
                disabled={live}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Stream key</label>
            <Input
              type="password"
              autoComplete="off"
              value={streamKey}
              onChange={(event) => setStreamKey(event.target.value)}
              placeholder="From YouTube Studio or Facebook Live"
              disabled={live}
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Camera</label>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={refreshing || live}
                  onClick={() => void refresh()}
                  className="h-5 gap-1 px-1.5 text-[0.625rem] text-muted-foreground"
                >
                  <RefreshCwIcon
                    className={cn("size-3", refreshing && "animate-spin")}
                  />
                  Refresh
                </Button>
              </div>
              <Select
                value={videoDevice || NONE}
                onValueChange={cameraSelect.commit}
                disabled={live}
              >
                <SelectTrigger
                  className="w-full"
                  onPointerDown={cameraSelect.arm}
                  onKeyDown={(event) =>
                    armOnActivationKey(event, cameraSelect.arm)
                  }
                >
                  <SelectValue placeholder="Select camera" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No camera</SelectItem>
                  {devices.video.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                      {isPhoneVirtualCam(name) ? " (phone)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                Audio (goes to the stream and saved video)
              </label>
              <Select
                value={audioDevice || NONE}
                onValueChange={audioSelect.commit}
                disabled={live}
              >
                <SelectTrigger
                  className="w-full"
                  onPointerDown={audioSelect.arm}
                  onKeyDown={(event) =>
                    armOnActivationKey(event, audioSelect.arm)
                  }
                >
                  <SelectValue placeholder="Select microphone" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Silent</SelectItem>
                  {devices.audio.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">
              Program look
            </label>
            <ProgramLookSwitch />
            <p className="text-[0.65rem] text-muted-foreground leading-snug">
              Camera is pulpit only. Slides is verses only. Mix is camera
              beside verses. Cutting to Slides keeps the camera ready so you can
              cut back instantly.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <label className="text-xs text-muted-foreground">
              YouTube / Facebook verse overlay
            </label>
            <Switch
              checked={includeOverlay}
              onPointerDown={overlaySwitch.arm}
              onKeyDown={(event) =>
                armOnActivationKey(event, overlaySwitch.arm)
              }
              onCheckedChange={overlaySwitch.commit}
              disabled={live}
            />
          </div>

          <p className="text-[0.65rem] text-muted-foreground leading-snug">
            Start and stop program video from the Record button in the top bar.
            Go live still needs a YouTube or Facebook key. REC and STREAM stay
            visible after this dialog closes.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "w-full gap-1.5",
                recording &&
                  "border-red-500/50 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-400",
              )}
              disabled={busy || live}
              onClick={() => {
                void useStreamSessionStore.getState().toggleProgramRecord()
              }}
            >
              <CircleIcon
                className={cn("size-3.5", recording && "fill-current")}
              />
              {recording ? "Stop recording" : "Record"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "w-full gap-1.5",
                live &&
                  "border-emerald-500/50 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-400",
              )}
              disabled={
                busy || ffmpegMissing || (!live && (!serverUrl || !streamKey))
              }
              onClick={() => {
                void (live ? handleStop() : handleGoLive())
              }}
            >
              <RadioIcon className="size-3.5" />
              {live ? "Stop live" : "Go live"}
            </Button>
          </div>
          <button
            type="button"
            className="flex items-center gap-1 text-[0.65rem] text-muted-foreground hover:text-foreground"
            onClick={() => {
              usePostProductionStore.getState().openModule("video")
            }}
          >
            <FolderOpenIcon className="size-3" />
            {recordings.length > 0
              ? `${recordings.length} saved video${recordings.length === 1 ? "" : "s"} — Post Production`
              : "Open videos in Post Production"}
          </button>
        </div>
      </div>
    </div>
  )
}
