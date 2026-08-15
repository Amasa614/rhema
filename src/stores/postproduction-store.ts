import { create } from "zustand"
import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import { readFile } from "@tauri-apps/plugin-fs"
import type { SermonSession, WaveformData } from "@/types/postproduction"
import type { VideoRecording } from "@/types/stream"

export type PostProductionModule = "audio" | "video"

interface PostProductionState {
  isOpen: boolean
  module: PostProductionModule
  sessions: SermonSession[]
  selectedSessionId: string | null
  activeRecordingSessionId: string | null
  waveform: WaveformData | null
  audioUrl: string | null
  loading: boolean
  processingStage: string | null
  error: string | null
  videoRecordings: VideoRecording[]
  selectedVideoId: string | null
  activeVideoRecordingId: string | null
  videoUrl: string | null
  videoLoading: boolean
  videoError: string | null
  setOpen: (open: boolean) => void
  openModule: (module: PostProductionModule) => void
  setModule: (module: PostProductionModule) => void
  setActiveRecording: (session: SermonSession | null) => void
  setProcessingStage: (stage: string | null) => void
  refresh: () => Promise<void>
  selectSession: (id: string) => Promise<void>
  upsertSession: (session: SermonSession) => void
  clearAudio: () => void
  refreshVideos: () => Promise<void>
  selectVideo: (id: string) => void
  upsertVideo: (recording: VideoRecording) => void
  setActiveVideoRecording: (recording: VideoRecording | null) => void
}

function sessionAudioPath(session: SermonSession): string {
  return session.cleanedAudioPath ?? session.editedAudioPath ?? session.rawAudioPath
}

function playbackUrl(path: string): string | null {
  try {
    return convertFileSrc(path)
  } catch {
    return null
  }
}

export const usePostProductionStore = create<PostProductionState>((set, get) => ({
  isOpen: false,
  module: "audio",
  sessions: [],
  selectedSessionId: null,
  activeRecordingSessionId: null,
  waveform: null,
  audioUrl: null,
  loading: false,
  processingStage: null,
  error: null,
  videoRecordings: [],
  selectedVideoId: null,
  activeVideoRecordingId: null,
  videoUrl: null,
  videoLoading: false,
  videoError: null,

  setOpen: (isOpen) => set({ isOpen }),
  openModule: (module) => set({ isOpen: true, module }),
  setModule: (module) => set({ module }),
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

  refreshVideos: async () => {
    set({ videoLoading: true, videoError: null })
    try {
      const videoRecordings = await invoke<VideoRecording[]>(
        "list_video_recordings"
      )
      const selectedVideoId =
        get().selectedVideoId &&
        videoRecordings.some((recording) => recording.id === get().selectedVideoId)
          ? get().selectedVideoId
          : (videoRecordings[0]?.id ?? null)
      set({ videoRecordings, selectedVideoId, videoLoading: false })
      if (selectedVideoId) {
        get().selectVideo(selectedVideoId)
      } else {
        set({ videoUrl: null })
      }
    } catch (error) {
      set({ videoError: String(error), videoLoading: false })
    }
  },

  selectVideo: (selectedVideoId) => {
    const recording = get().videoRecordings.find(
      (item) => item.id === selectedVideoId
    )
    if (!recording) return
    const isRecording = selectedVideoId === get().activeVideoRecordingId
    set({
      selectedVideoId,
      videoUrl: isRecording ? null : playbackUrl(recording.videoPath),
      videoError: null,
    })
  },

  upsertVideo: (recording) =>
    set((state) => ({
      videoRecordings: [
        recording,
        ...state.videoRecordings.filter((existing) => existing.id !== recording.id),
      ],
    })),

  setActiveVideoRecording: (recording) => {
    if (!recording) {
      set({ activeVideoRecordingId: null })
      return
    }
    set((state) => ({
      activeVideoRecordingId: recording.id,
      videoRecordings: [
        recording,
        ...state.videoRecordings.filter((existing) => existing.id !== recording.id),
      ],
      selectedVideoId: state.selectedVideoId ?? recording.id,
      videoUrl:
        state.selectedVideoId === recording.id || !state.selectedVideoId
          ? null
          : state.videoUrl,
    }))
  },
}))
