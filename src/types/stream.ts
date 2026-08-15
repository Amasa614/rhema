export type StreamDestinationPreset = "youtube" | "facebook" | "custom"

export interface DshowDevices {
  video: string[]
  audio: string[]
}

export interface StreamStatus {
  active: boolean
  ffmpegPath: string | null
  lastError: string | null
  overlayPath: string | null
}

export interface StreamStartPayload {
  serverUrl: string
  streamKey: string
  videoDevice: string | null
  audioDevice: string | null
  includeOverlay: boolean
  width?: number
  height?: number
  fps?: number
  videoBitrateKbps?: number
  recordLocal?: boolean
}

export type ProgramLook = "camera" | "slides" | "mix"

export interface ProgramLookPayload {
  look: ProgramLook
  deviceLabel?: string
  releaseCamera?: boolean
}

export interface ProgramPreviewPayload {
  look: ProgramLook
  jpeg: string | null
}

export interface CameraUnderlayPayload {
  active: boolean
  deviceLabel?: string
}

export interface VideoRecording {
  id: string
  title: string
  createdAt: string
  durationSeconds: number
  videoPath: string
}

export interface VideoEditRange {
  startSeconds: number
  endSeconds: number
}

export interface ExtractedAudio {
  recordingId: string
  audioPath: string
}
