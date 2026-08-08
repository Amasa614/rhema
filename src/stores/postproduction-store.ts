import { create } from "zustand"
import { invoke } from "@tauri-apps/api/core"
import { readFile } from "@tauri-apps/plugin-fs"
import type { SermonSession, WaveformData } from "@/types/postproduction"

interface PostProductionState {
  isOpen: boolean
  sessions: SermonSession[]
  selectedSessionId: string | null
  activeRecordingSessionId: string | null
  waveform: WaveformData | null
  audioUrl: string | null
  loading: boolean
  processingStage: string | null
  error: string | null
  setOpen: (open: boolean) => void
  setActiveRecording: (session: SermonSession | null) => void
  setProcessingStage: (stage: string | null) => void
  refresh: () => Promise<void>
  selectSession: (id: string) => Promise<void>
  upsertSession: (session: SermonSession) => void
  clearAudio: () => void
}

function sessionAudioPath(session: SermonSession): string {
  return session.cleanedAudioPath ?? session.editedAudioPath ?? session.rawAudioPath
}

export const usePostProductionStore = create<PostProductionState>((set, get) => ({
  isOpen: false,
  sessions: [],
  selectedSessionId: null,
  activeRecordingSessionId: null,
  waveform: null,
  audioUrl: null,
  loading: false,
  processingStage: null,
  error: null,

  setOpen: (isOpen) => set({ isOpen }),
  setActiveRecording: (session) => {
    if (!session) {
      set({ activeRecordingSessionId: null })
      return
    }
    set((state) => ({
      activeRecordingSessionId: session.id,
      sessions: [
        session,
        ...state.sessions.filter((existing) => existing.id !== session.id),
      ],
      selectedSessionId: state.selectedSessionId ?? session.id,
    }))
  },
  setProcessingStage: (processingStage) => set({ processingStage }),

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const sessions = await invoke<SermonSession[]>("list_sermon_sessions")
      const selectedSessionId =
        get().selectedSessionId &&
        sessions.some((session) => session.id === get().selectedSessionId)
          ? get().selectedSessionId
          : (sessions[0]?.id ?? null)
      set({ sessions, selectedSessionId, loading: false })
      if (selectedSessionId) {
        await get().selectSession(selectedSessionId)
      }
    } catch (error) {
      set({ error: String(error), loading: false })
    }
  },

  selectSession: async (selectedSessionId) => {
    const session = get().sessions.find((item) => item.id === selectedSessionId)
    if (!session) return
    const oldUrl = get().audioUrl
    set({
      selectedSessionId,
      waveform: null,
      audioUrl: null,
      loading: true,
      error: null,
    })
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    if (selectedSessionId === get().activeRecordingSessionId) {
      set({ loading: false })
      return
    }
    try {
      const [waveform, bytes] = await Promise.all([
        invoke<WaveformData>("analyze_sermon_audio", {
          sessionId: selectedSessionId,
          points: 1_200,
        }),
        readFile(sessionAudioPath(session)),
      ])
      const extension = sessionAudioPath(session).toLowerCase()
      const mime = extension.endsWith(".mp3") ? "audio/mpeg" : "audio/wav"
      const audioUrl = URL.createObjectURL(new Blob([bytes], { type: mime }))
      set({ waveform, audioUrl, loading: false })
    } catch (error) {
      set({ error: String(error), loading: false })
    }
  },

  upsertSession: (session) =>
    set((state) => ({
      sessions: [
        session,
        ...state.sessions.filter((existing) => existing.id !== session.id),
      ],
    })),

  clearAudio: () => {
    const audioUrl = get().audioUrl
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    set({ audioUrl: null, waveform: null })
  },
}))
