import { create } from "zustand"
import { emitTo } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { programLookUsesCamera } from "@/lib/program-look"
import { usePostProductionStore } from "@/stores/postproduction-store"
import { useSettingsStore } from "@/stores/settings-store"
import { redactRtmpSecrets } from "@/lib/stream-secrets"
import type { DshowDevices, ProgramLook, ProgramLookPayload, StreamStatus } from "@/types/stream"

interface StreamSessionState {
  live: boolean
  pendingRecord: boolean
  ffmpegPath: string | null
  lastError: string | null
  statusReady: boolean
  applyStatus: (status: Pick<StreamStatus, "active" | "ffmpegPath" | "lastError">) => void
  setPendingRecord: (pendingRecord: boolean) => void
  toggleProgramRecord: () => Promise<void>
  setProgramLook: (look: ProgramLook) => Promise<void>
}

function isPhoneVirtualCam(name: string): boolean {
  return /camo|iriun/i.test(name)
}

export function emitProgramLook(
  look: ProgramLook,
  deviceLabel: string,
  extra?: { releaseCamera?: boolean },
): void {
  const payload: ProgramLookPayload = {
    look,
    deviceLabel,
    releaseCamera: extra?.releaseCamera,
  }
  void emitTo("broadcast", "broadcast:program-look", payload)
  globalThis.setTimeout(() => {
    void emitTo("broadcast", "broadcast:program-look", payload)
  }, 200)
}

/** Release or restore the projector camera without changing the saved look. */
export function emitProjectorCamera(active: boolean, deviceLabel: string): void {
  if (active) {
    const look = useSettingsStore.getState().streamProgramLook
    emitProgramLook(look === "slides" ? "mix" : look, deviceLabel)
    return
  }
  emitProgramLook("slides", "", { releaseCamera: true })
}

async function ensureProgramWindow(): Promise<void> {
  await invoke("ensure_broadcast_window", { outputId: "main" })
  const visible = await invoke<boolean>("is_broadcast_window_visible", {
    outputId: "main",
  })
  if (!visible) {
    await invoke("open_broadcast_window", {
      outputId: "main",
      monitorIndex: 0,
    })
  }
}

async function ensureCameraDevice(): Promise<string> {
  const settings = useSettingsStore.getState()
  let device = settings.streamVideoDevice
  if (!device) {
    const listed = await invoke<DshowDevices>("stream_list_devices").catch(
      () => ({ video: [] as string[], audio: [] as string[] }),
    )
    device =
      listed.video.find(isPhoneVirtualCam) ?? listed.video[0] ?? ""
    if (device) settings.setStreamVideoDevice(device)
  }
  if (!device) {
    throw new Error("Pick a camera in Broadcast first. Start Iriun, then Refresh.")
  }
  return device
}

export function isProgramRecording(): boolean {
  const session = useStreamSessionStore.getState()
  const videoId = usePostProductionStore.getState().activeVideoRecordingId
  return session.pendingRecord || Boolean(videoId)
}

export const useStreamSessionStore = create<StreamSessionState>((set, get) => ({
  live: false,
  pendingRecord: false,
  ffmpegPath: null,
  lastError: null,
  statusReady: false,

  applyStatus: (status) =>
    set({
      live: status.active,
      ffmpegPath: status.ffmpegPath,
      lastError: status.lastError
        ? redactRtmpSecrets(status.lastError, useSettingsStore.getState().streamKey)
        : null,
      statusReady: true,
    }),

  setPendingRecord: (pendingRecord) => set({ pendingRecord }),

  setProgramLook: async (look) => {
    try {
      let device = useSettingsStore.getState().streamVideoDevice
      if (programLookUsesCamera(look)) {
        device = await ensureCameraDevice()
      }
      await ensureProgramWindow()
      useSettingsStore.getState().setStreamProgramLook(look)
      emitProgramLook(look, device)
    } catch (error) {
      toast.error("Could not change program look", {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  },

  toggleProgramRecord: async () => {
    if (get().live) {
      toast.error("Stop the live stream before recording from the projector")
      return
    }
    if (isProgramRecording()) {
      await emitTo("broadcast", "broadcast:record", { active: false })
      set({ pendingRecord: false })
      toast.success("Video saved", {
        description: "Open Post Production → Video to review it.",
        action: {
          label: "Open",
          onClick: () => {
            usePostProductionStore.getState().openModule("video")
          },
        },
      })
      return
    }
    try {
      set({ pendingRecord: true })
      const settings = useSettingsStore.getState()
      const look = settings.streamProgramLook
      await ensureProgramWindow()
      if (programLookUsesCamera(look)) {
        const device = await ensureCameraDevice()
        emitProgramLook(look, device)
      } else {
        emitProgramLook("slides", settings.streamVideoDevice)
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
      await emitTo("broadcast", "broadcast:record", { active: true })
      toast.success("Recording program video")
    } catch (error) {
      set({ pendingRecord: false })
      toast.error("Could not start recording", {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  },
}))
