import { invoke } from "@tauri-apps/api/core"
import { emitTo, listen } from "@tauri-apps/api/event"
import { toast } from "sonner"
import { usePostProductionStore } from "@/stores/postproduction-store"
import { emitProjectorCamera, useStreamSessionStore } from "@/stores/stream-session-store"
import { useSettingsStore } from "@/stores/settings-store"
import { redactRtmpSecrets } from "@/lib/stream-secrets"
import { programLookUsesCamera } from "@/lib/program-look"
import type { StreamStatus, VideoRecording } from "@/types/stream"

let didInit = false

/** Keep livestream and program-record status alive after Broadcast closes. */
export function initStreamSession(): void {
  if (didInit) return
  didInit = true

  void invoke<StreamStatus>("stream_status")
    .then((status) => {
      useStreamSessionStore.getState().applyStatus(status)
    })
    .catch(() => {})

  void listen<{ active?: boolean; error?: string }>("stream:status", (event) => {
    const current = useStreamSessionStore.getState()
    const wasLive = current.live
    current.applyStatus({
      active: Boolean(event.payload.active),
      ffmpegPath: current.ffmpegPath,
      lastError: event.payload.error ?? null,
    })
    const isLive = useStreamSessionStore.getState().live
    if (wasLive && !isLive) {
      current.setPendingRecord(false)
      void emitTo("broadcast", "broadcast:stream-overlay", { active: false }).catch(() => {})
      const settings = useSettingsStore.getState()
      if (settings.streamVideoDevice && (
        programLookUsesCamera(settings.streamProgramLook) || settings.streamShowOnProjector
      )) {
        emitProjectorCamera(true, settings.streamVideoDevice)
      }
      if (event.payload.error) {
        toast.error("Live stream stopped", {
          description: redactRtmpSecrets(event.payload.error, settings.streamKey),
        })
      }
    }
  })

  void listen<{ error?: string }>("broadcast:record-error", (event) => {
    useStreamSessionStore.getState().setPendingRecord(false)
    toast.error("Could not record video", {
      description:
        event.payload.error ?? "Try Record again after the projector is open.",
    })
  })

  void listen<VideoRecording>("video_recording_started", ({ payload }) => {
    usePostProductionStore.getState().setActiveVideoRecording(payload)
  })

  void listen<VideoRecording>("video_recording_saved", ({ payload }) => {
    const store = usePostProductionStore.getState()
    store.upsertVideo(payload)
    if (store.activeVideoRecordingId === payload.id) {
      store.setActiveVideoRecording(null)
    }
    useStreamSessionStore.getState().setPendingRecord(false)
    const next = usePostProductionStore.getState()
    if (next.isOpen && next.module === "video") {
      next.selectVideo(payload.id)
    }
  })
}
