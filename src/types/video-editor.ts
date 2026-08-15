export type MediaKind = "video" | "audio" | "image"

export type MediaAssetRole =
  | "program"
  | "extracted"
  | "imported"
  | "export"

export type TrackKind = "video" | "audio"

export type ExportMode = "videoAudio" | "videoOnly" | "audioOnly"

export type EditorJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export interface MediaAsset {
  id: string
  kind: MediaKind
  role: MediaAssetRole
  label: string
  path: string
  durationSeconds: number
  hasEmbeddedAudio: boolean
  offline: boolean
  createdAt: string
  recordingId?: string
  waveformPeaks?: number[]
}

export interface TimelineClip {
  id: string
  trackId: string
  assetId: string
  timelineStart: number
  sourceIn: number
  sourceOut: number
  muted: boolean
  /** When true, this video clip does not play its embedded audio (e.g. after detach). */
  muteEmbeddedAudio: boolean
  volume: number
  locked: boolean
}

export interface TimelineTrack {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  locked: boolean
}

export interface VideoEditorProject {
  version: 1
  id: string
  title: string
  createdAt: string
  updatedAt: string
  assets: MediaAsset[]
  tracks: TimelineTrack[]
  clips: TimelineClip[]
}

export interface EditorExportSettings {
  mode: ExportMode
  /** Optional absolute destination path. Empty = save into videos library. */
  destinationPath?: string
  audioFormat?: "wav" | "mp3"
}

export interface EditorJobProgress {
  jobId: string
  projectId?: string
  stage: string
  percent: number | null
  status: EditorJobStatus
  error?: string
  resultPath?: string
  resultRecordingId?: string
}

export interface EditorProjectSummary {
  id: string
  title: string
  updatedAt: string
  durationSeconds: number
  clipCount: number
}

export const DEFAULT_TRACKS: TimelineTrack[] = [
  { id: "V1", kind: "video", name: "V1", muted: false, locked: false },
  { id: "A1", kind: "audio", name: "A1", muted: false, locked: false },
  { id: "A2", kind: "audio", name: "A2", muted: false, locked: false },
]
