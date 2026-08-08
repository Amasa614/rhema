export interface SermonScripture {
  reference: string
  source: "ai-direct" | "queued"
}

export interface SermonSession {
  id: string
  title: string
  createdAt: string
  durationSeconds: number
  rawAudioPath: string
  editedAudioPath: string | null
  cleanedAudioPath: string | null
  transcript: string
  summary: string
  scriptures: SermonScripture[]
  /** Legacy unclassified references from sessions created before provenance tracking. */
  verses: string[]
  cleanvoiceJobId: string | null
}

export interface WaveformData {
  durationSeconds: number
  peaks: number[]
}

export interface CleanvoiceProgress {
  sessionId: string
  stage: string
}
