import { create } from "zustand"
import { load, type Store } from "@tauri-apps/plugin-store"
import type { ProgramLook, StreamDestinationPreset } from "@/types/stream"

type SttProvider = "deepgram" | "whisper"

interface SettingsState {
  deepgramApiKey: string | null
  openaiApiKey: string | null
  claudeApiKey: string | null
  cleanvoiceApiKey: string | null
  audioDeviceId: string | null
  gain: number
  autoMode: boolean
  confidenceThreshold: number
  cooldownMs: number
  onboardingComplete: boolean
  sttProvider: SttProvider
  streamPreset: StreamDestinationPreset
  streamServerUrl: string
  streamKey: string
  streamVideoDevice: string
  streamAudioDevice: string
  streamIncludeOverlay: boolean
  streamShowOnProjector: boolean
  streamProgramLook: ProgramLook

  setDeepgramApiKey: (key: string | null) => void
  setOpenaiApiKey: (key: string | null) => void
  setClaudeApiKey: (key: string | null) => void
  setCleanvoiceApiKey: (key: string | null) => void
  setAudioDeviceId: (id: string | null) => void
  setGain: (gain: number) => void
  setAutoMode: (auto: boolean) => void
  setConfidenceThreshold: (threshold: number) => void
  setCooldownMs: (ms: number) => void
  setOnboardingComplete: (complete: boolean) => void
  setSttProvider: (provider: SttProvider) => void
  setStreamPreset: (preset: StreamDestinationPreset) => void
  setStreamServerUrl: (url: string) => void
  setStreamKey: (key: string) => void
  setStreamVideoDevice: (id: string) => void
  setStreamAudioDevice: (id: string) => void
  setStreamIncludeOverlay: (include: boolean) => void
  setStreamShowOnProjector: (show: boolean) => void
  setStreamProgramLook: (look: ProgramLook) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  deepgramApiKey: null,
  openaiApiKey: null,
  claudeApiKey: null,
  cleanvoiceApiKey: null,
  audioDeviceId: null,
  gain: 1.0,
  autoMode: false,
  confidenceThreshold: 0.8,
  cooldownMs: 2500,
  onboardingComplete: false,
  sttProvider: "deepgram",
  streamPreset: "youtube",
  streamServerUrl: "rtmps://a.rtmps.youtube.com/live2",
  streamKey: "",
  streamVideoDevice: "",
  streamAudioDevice: "",
  streamIncludeOverlay: true,
  streamShowOnProjector: false,
  streamProgramLook: "slides",

  setDeepgramApiKey: (deepgramApiKey) => set({ deepgramApiKey }),
  setOpenaiApiKey: (openaiApiKey) => set({ openaiApiKey }),
  setClaudeApiKey: (claudeApiKey) => set({ claudeApiKey }),
  setCleanvoiceApiKey: (cleanvoiceApiKey) => set({ cleanvoiceApiKey }),
  setAudioDeviceId: (audioDeviceId) => set({ audioDeviceId }),
  setGain: (gain) => set({ gain }),
  setAutoMode: (autoMode) => set({ autoMode }),
  setConfidenceThreshold: (confidenceThreshold) => set({ confidenceThreshold }),
  setCooldownMs: (cooldownMs) => set({ cooldownMs }),
  setOnboardingComplete: (onboardingComplete) => set({ onboardingComplete }),
  setSttProvider: (sttProvider) => set({ sttProvider }),
  setStreamPreset: (streamPreset) => set({ streamPreset }),
  setStreamServerUrl: (streamServerUrl) => set({ streamServerUrl }),
  setStreamKey: (streamKey) => set({ streamKey }),
  setStreamVideoDevice: (streamVideoDevice) => set({ streamVideoDevice }),
  setStreamAudioDevice: (streamAudioDevice) => set({ streamAudioDevice }),
  setStreamIncludeOverlay: (streamIncludeOverlay) =>
    set({ streamIncludeOverlay }),
  setStreamShowOnProjector: (streamShowOnProjector) => {
    const look = get().streamProgramLook
    set({
      streamShowOnProjector,
      streamProgramLook: streamShowOnProjector
        ? look === "slides"
          ? "mix"
          : look
        : "slides",
    })
  },
  setStreamProgramLook: (streamProgramLook) =>
    set({
      streamProgramLook,
      streamShowOnProjector: streamProgramLook !== "slides",
    }),
}))

const PERSISTED_KEYS = [
  "deepgramApiKey",
  "openaiApiKey",
  "claudeApiKey",
  "cleanvoiceApiKey",
  "audioDeviceId",
  "gain",
  "autoMode",
  "confidenceThreshold",
  "cooldownMs",
  "onboardingComplete",
  "sttProvider",
  "streamPreset",
  "streamServerUrl",
  "streamKey",
  "streamVideoDevice",
  "streamAudioDevice",
  "streamIncludeOverlay",
  "streamShowOnProjector",
  "streamProgramLook",
] as const satisfies readonly (keyof SettingsState)[]

let tauriStore: Store | null = null
let hydrationPromise: Promise<void> | null = null

async function getStore(): Promise<Store> {
  if (!tauriStore) {
    tauriStore = await load("settings.json", { autoSave: false, defaults: {} })
  }
  return tauriStore
}

/** Load all persisted settings into the Zustand store. Idempotent and
 *  safe against concurrent callers — the first call owns the work and
 *  subsequent callers await the same promise. */
export function hydrateSettings(): Promise<void> {
  if (hydrationPromise) return hydrationPromise
  hydrationPromise = (async () => {
    try {
      const store = await getStore()
      const patch: Partial<SettingsState> = {}
      for (const key of PERSISTED_KEYS) {
        const value = await store.get(key)
        if (value !== undefined && value !== null) {
          ;(patch as Record<string, unknown>)[key] = value
        }
      }
      const savedLook = patch.streamProgramLook
      if (
        savedLook !== "camera" &&
        savedLook !== "slides" &&
        savedLook !== "mix"
      ) {
        patch.streamProgramLook = patch.streamShowOnProjector ? "mix" : "slides"
      }
      patch.streamShowOnProjector = patch.streamProgramLook !== "slides"
      if (
        typeof patch.streamServerUrl === "string" &&
        patch.streamServerUrl.includes("live-api-s.facebook.com")
      ) {
        patch.streamServerUrl = "rtmps://rtmp-api.facebook.com:443/rtmp/"
      }
      if (Object.keys(patch).length > 0) {
        useSettingsStore.setState(patch)
      }

      // Attach only after successful hydration so as not to overwrite disk with defaults.
      // Debounce writes, so a dragged slider (e.g. gain) coalesces into a single disk write.
      useSettingsStore.subscribe((state, prevState) => {
        const changed = PERSISTED_KEYS.some((k) => state[k] !== prevState[k])
        if (!changed) return
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
          saveTimer = null
          pendingSave = pendingSave.then(() =>
            persistAll(useSettingsStore.getState())
          )
        }, SAVE_DEBOUNCE_MS)
      })
    } catch {
      console.warn("[settings] Failed to load persisted state, using defaults")
    }
  })()
  return hydrationPromise
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: Promise<void> = Promise.resolve()
const SAVE_DEBOUNCE_MS = 250

async function persistAll(state: SettingsState): Promise<void> {
  try {
    const store = await getStore()
    for (const key of PERSISTED_KEYS) {
      await store.set(key, state[key] as unknown)
    }
    await store.save()
  } catch {
    console.warn("[settings] Failed to persist settings")
  }
}
