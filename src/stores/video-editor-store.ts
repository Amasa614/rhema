import { create } from "zustand"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { WaveformData } from "@/types/postproduction"
import type {
  EditorExportSettings,
  EditorJobProgress,
  EditorProjectSummary,
  MediaAsset,
  TimelineClip,
  TimelineTrack,
  VideoEditorProject,
} from "@/types/video-editor"
import {
  assetById,
  canPlaceAssetOnTrack,
  clipDuration,
  clipEnd,
  clipsForAsset,
  clipsOnTrack,
  createEmptyProject,
  findClipAtPlayhead,
  newClipId,
  nextVideoAppendStart,
  projectDuration,
  splitClipAtPlayhead,
  trackById,
  trimClipEnd,
  trimClipStart,
  validateProject,
} from "@/lib/video-editor/timeline"

const HISTORY_LIMIT = 50

let didInitJobListener = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

function ensureJobListener() {
  if (didInitJobListener) return
  didInitJobListener = true
  void listen<EditorJobProgress>("video_editor_job", ({ payload }) => {
    useVideoEditorStore.getState().applyJob(payload)
  })
}

function withHistory(
  past: VideoEditorProject[],
  next: VideoEditorProject,
): VideoEditorProject[] {
  const copy = [...past, next]
  if (copy.length <= HISTORY_LIMIT) return copy
  return copy.slice(copy.length - HISTORY_LIMIT)
}

function normalizeSelection(project: VideoEditorProject, ids: string[]): string[] {
  const existing = new Set(project.clips.map((clip) => clip.id))
  return ids.filter((id) => existing.has(id))
}

interface VideoEditorState {
  projects: EditorProjectSummary[]
  library: MediaAsset[]
  project: VideoEditorProject | null
  selectedClipIds: string[]
  /** When set, the viewer shows this library/project asset instead of the timeline. */
  previewAssetId: string | null
  playhead: number
  zoom: number
  snap: boolean
  exportOpen: boolean
  exportMode: EditorExportSettings["mode"]
  job: EditorJobProgress | null
  busy: boolean
  error: string | null

  past: VideoEditorProject[]
  future: VideoEditorProject[]

  refreshProjects: () => Promise<void>
  refreshLibrary: () => Promise<void>
  createProject: (title?: string) => Promise<void>
  createProjectFromRecording: (recordingId: string) => Promise<void>
  loadProject: (projectId: string) => Promise<void>
  saveProjectNow: () => Promise<void>
  scheduleSave: () => void
  deleteProject: (projectId: string) => Promise<void>

  importMedia: (path: string) => Promise<void>
  attachLibraryAsset: (assetId: string) => void
  detachAudioFromSelected: () => Promise<void>
  setProjectTitle: (title: string) => void
  closeProject: () => void

  setPlayhead: (playhead: number) => void
  setZoom: (zoom: number) => void
  setSnap: (snap: boolean) => void
  setSelectedClipIds: (ids: string[]) => void
  selectClip: (id: string, additive?: boolean) => void
  setPreviewAsset: (assetId: string | null) => void
  focusAsset: (assetId: string) => void
  clearSelection: () => void

  addClip: (assetId: string, trackId: string, timelineStart?: number) => void
  updateClip: (clipId: string, updater: (clip: TimelineClip) => TimelineClip) => void
  deleteSelected: () => void
  duplicateSelected: () => void
  splitSelectedAtPlayhead: () => void

  undo: () => void
  redo: () => void

  setExportOpen: (open: boolean) => void
  setExportMode: (mode: EditorExportSettings["mode"]) => void
  exportProject: (destinationPath?: string) => Promise<void>
  cancelExport: () => Promise<void>
  applyJob: (job: EditorJobProgress) => void
}

export const useVideoEditorStore = create<VideoEditorState>((set, get) => ({
  projects: [],
  library: [],
  project: null,
  selectedClipIds: [],
  previewAssetId: null,
  playhead: 0,
  zoom: 90,
  snap: true,
  exportOpen: false,
  exportMode: "videoAudio",
  job: null,
  busy: false,
  error: null,

  past: [],
  future: [],

  refreshProjects: async () => {
    ensureJobListener()
    try {
      const projects = await invoke<EditorProjectSummary[]>("list_editor_projects")
      set({ projects })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  refreshLibrary: async () => {
    ensureJobListener()
    try {
      const library = await invoke<MediaAsset[]>("list_editor_media_assets")
      set({ library })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  createProject: async (title) => {
    ensureJobListener()
    set({ busy: true, error: null })
    try {
      const project = await invoke<VideoEditorProject>("create_editor_project", {
        title,
      })
      set({
        project,
        past: [],
        future: [],
        selectedClipIds: [],
        previewAssetId: null,
        playhead: 0,
      })
      await get().refreshProjects()
    } catch (error) {
      set({ error: String(error) })
    } finally {
      set({ busy: false })
    }
  },

  createProjectFromRecording: async (recordingId) => {
    ensureJobListener()
    set({ busy: true, error: null })
    try {
      const project = await invoke<VideoEditorProject>(
        "create_editor_project_from_recording",
        { recordingId },
      )
      set({
        project,
        past: [],
        future: [],
        selectedClipIds: project.clips[0]?.id ? [project.clips[0].id] : [],
        previewAssetId: null,
        playhead: 0,
      })
      await get().refreshProjects()
    } catch (error) {
      set({ error: String(error) })
    } finally {
      set({ busy: false })
    }
  },

  loadProject: async (projectId) => {
    ensureJobListener()
    set({ busy: true, error: null })
    try {
      const project = await invoke<VideoEditorProject>("load_editor_project", {
        projectId,
      })
      set({
        project,
        past: [],
        future: [],
        selectedClipIds: [],
        previewAssetId: null,
        playhead: 0,
      })
    } catch (error) {
      set({ error: String(error) })
    } finally {
      set({ busy: false })
    }
  },

  saveProjectNow: async () => {
    ensureJobListener()
    const project = get().project
    if (!project) return
    const errors = validateProject(project)
    if (errors.length > 0) {
      set({ error: errors[0] ?? "Project is invalid" })
      return
    }
    try {
      const saved = await invoke<VideoEditorProject>("save_editor_project", {
        project,
      })
      set({
        project: saved,
        selectedClipIds: normalizeSelection(saved, get().selectedClipIds),
      })
      await get().refreshProjects()
    } catch (error) {
      set({ error: String(error) })
    }
  },

  scheduleSave: () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void get().saveProjectNow()
    }, 900)
  },

  deleteProject: async (projectId) => {
    ensureJobListener()
    set({ busy: true, error: null })
    try {
      await invoke("delete_editor_project", { projectId })
      const current = get().project
      if (current?.id === projectId) {
        set({ project: null, selectedClipIds: [], past: [], future: [] })
      }
      await get().refreshProjects()
    } catch (error) {
      set({ error: String(error) })
    } finally {
      set({ busy: false })
    }
  },

  importMedia: async (path) => {
    ensureJobListener()
    const project = get().project
    if (!project) return
    set({ busy: true, error: null })
    try {
      const imported = await invoke<MediaAsset>("import_editor_media", {
        projectId: project.id,
        path,
      })

      let asset = imported
      if (asset.kind === "audio" && !asset.waveformPeaks) {
        try {
          const waveform = await invoke<WaveformData>("analyze_editor_audio", {
            path: asset.path,
            points: 900,
          })
          asset = {
            ...asset,
            durationSeconds: waveform.durationSeconds,
            waveformPeaks: waveform.peaks,
          }
        } catch {
          // waveform is optional; keep import working
        }
      }

      const next: VideoEditorProject = {
        ...project,
        assets: [asset, ...project.assets.filter((a) => a.id !== asset.id)],
        updatedAt: new Date().toISOString(),
      }
      set({
        past: withHistory(get().past, project),
        future: [],
        project: next,
      })
      get().scheduleSave()
      await get().refreshLibrary()
    } catch (error) {
      set({ error: String(error) })
    } finally {
      set({ busy: false })
    }
  },

  attachLibraryAsset: (assetId) => {
    const project = get().project
    if (!project) return
    if (project.assets.some((asset) => asset.id === assetId)) return
    const fromLibrary = get().library.find((asset) => asset.id === assetId)
    if (!fromLibrary) return
    const next: VideoEditorProject = {
      ...project,
      assets: [fromLibrary, ...project.assets],
      updatedAt: new Date().toISOString(),
    }
    set({
      past: withHistory(get().past, project),
      future: [],
      project: next,
    })
    get().scheduleSave()
  },

  detachAudioFromSelected: async () => {
    ensureJobListener()
    const project = get().project
    if (!project) return
    const selectedId = get().selectedClipIds[0]
    if (!selectedId) return
    const clip = project.clips.find((c) => c.id === selectedId)
    if (!clip) return
    const asset = assetById(project, clip.assetId)
    if (!asset) return
    if (asset.kind !== "video" || !asset.hasEmbeddedAudio) {
      set({ error: "This clip has no embedded audio to extract." })
      return
    }
    set({ busy: true, error: null })
    try {
      const audioAsset = await invoke<MediaAsset>("detach_editor_audio", {
        projectId: project.id,
        assetId: asset.id,
        sourcePath: asset.path,
        label: asset.label,
      })

      const audioTrack = project.tracks.find((t) => t.kind === "audio" && !t.locked)
      const trackId = audioTrack?.id ?? "A1"
      const newAudioClip: TimelineClip = {
        id: newClipId(),
        trackId,
        assetId: audioAsset.id,
        timelineStart: clip.timelineStart,
        sourceIn: clip.sourceIn,
        sourceOut: clip.sourceOut,
        muted: false,
        muteEmbeddedAudio: false,
        volume: 1,
        locked: false,
      }
      const nextClips = project.clips.map((existing) =>
        existing.id === clip.id
          ? { ...existing, muteEmbeddedAudio: true }
          : existing,
      )
      const next: VideoEditorProject = {
        ...project,
        assets: [audioAsset, ...project.assets.filter((a) => a.id !== audioAsset.id)],
        clips: [...nextClips, newAudioClip],
        updatedAt: new Date().toISOString(),
      }
      set({
        past: withHistory(get().past, project),
        future: [],
        project: next,
        selectedClipIds: [newAudioClip.id],
      })
      get().scheduleSave()
      await get().refreshLibrary()
    } catch (error) {
      set({ error: String(error) })
    } finally {
      set({ busy: false })
    }
  },

  setProjectTitle: (title) => {
    const project = get().project
    if (!project) return
    const trimmed = title.trim()
    if (!trimmed || trimmed === project.title) return
    const next: VideoEditorProject = {
      ...project,
      title: trimmed,
      updatedAt: new Date().toISOString(),
    }
    set({
      past: withHistory(get().past, project),
      future: [],
      project: next,
    })
    get().scheduleSave()
    void get().refreshProjects()
  },

  closeProject: () => {
    set({
      project: null,
      selectedClipIds: [],
      previewAssetId: null,
      playhead: 0,
      past: [],
      future: [],
      job: null,
      exportOpen: false,
      error: null,
    })
  },

  setPlayhead: (playhead) => {
    const project = get().project
    const max = project ? projectDuration(project) : 0
    set({ playhead: Math.max(0, Math.min(playhead, max)) })
  },

  setZoom: (zoom) => set({ zoom: Math.max(20, Math.min(zoom, 260)) }),
  setSnap: (snap) => set({ snap }),

  setSelectedClipIds: (selectedClipIds) => {
    const project = get().project
    if (!project) {
      set({ selectedClipIds: [], previewAssetId: null })
      return
    }
    set({
      selectedClipIds: normalizeSelection(project, selectedClipIds),
      previewAssetId: null,
    })
  },

  selectClip: (id, additive = false) => {
    const project = get().project
    if (!project) return
    const exists = project.clips.some((clip) => clip.id === id)
    if (!exists) return
    if (!additive) {
      set({ selectedClipIds: [id], previewAssetId: null })
      return
    }
    set((state) => {
      const next = new Set(state.selectedClipIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedClipIds: [...next], previewAssetId: null }
    })
  },

  setPreviewAsset: (previewAssetId) => {
    if (!previewAssetId) {
      set({ previewAssetId: null })
      return
    }
    set({ previewAssetId, selectedClipIds: [] })
  },

  focusAsset: (assetId) => {
    const project = get().project
    if (!project) return
    const asset =
      assetById(project, assetId) ?? get().library.find((item) => item.id === assetId)
    if (!asset || asset.offline) return

    const existing = clipsForAsset(project, asset)[0]
    if (existing) {
      set({
        previewAssetId: asset.id,
        selectedClipIds: [existing.id],
        playhead: existing.timelineStart,
      })
      return
    }

    const targetTrack = asset.kind === "audio" ? "A1" : "V1"
    get().addClip(asset.id, targetTrack)
    const next = get().project
    const clip = next ? clipsForAsset(next, asset)[0] : undefined
    if (!clip) return
    set({
      previewAssetId: asset.id,
      selectedClipIds: [clip.id],
      playhead: clip.timelineStart,
    })
  },

  clearSelection: () => set({ selectedClipIds: [] }),

  addClip: (assetId, trackId, timelineStart) => {
    const project = get().project
    if (!project) return
    const asset = assetById(project, assetId) ?? get().library.find((a) => a.id === assetId)
    const track = trackById(project, trackId)
    if (!asset || !track) return
    if (!canPlaceAssetOnTrack(asset, track)) return
    const assets = project.assets.some((existing) => existing.id === asset.id)
      ? project.assets
      : [asset, ...project.assets]

    const duration = Math.max(asset.durationSeconds, 0.1)
    const start =
      timelineStart ?? (track.kind === "video" ? nextVideoAppendStart(project) : get().playhead)
    const clip: TimelineClip = {
      id: newClipId(),
      trackId,
      assetId,
      timelineStart: Math.max(0, start),
      sourceIn: 0,
      sourceOut: duration,
      muted: false,
      muteEmbeddedAudio: track.kind === "audio" ? true : false,
      volume: 1,
      locked: false,
    }
    const next: VideoEditorProject = {
      ...project,
      assets,
      clips: [...project.clips, clip],
      updatedAt: new Date().toISOString(),
    }
    set({
      past: withHistory(get().past, project),
      future: [],
      project: next,
      selectedClipIds: [clip.id],
      previewAssetId: asset.id,
      playhead: clip.timelineStart,
    })
    get().scheduleSave()
  },

  updateClip: (clipId, updater) => {
    const project = get().project
    if (!project) return
    const index = project.clips.findIndex((clip) => clip.id === clipId)
    if (index < 0) return
    const prev = project.clips[index]!
    const nextClip = updater(prev)
    // Avoid newer Array.prototype.toSpliced() for WebView2 compatibility.
    const nextClips = project.clips.slice()
    nextClips.splice(index, 1, nextClip)
    const nextProject: VideoEditorProject = {
      ...project,
      clips: nextClips,
      updatedAt: new Date().toISOString(),
    }
    set({
      past: withHistory(get().past, project),
      future: [],
      project: nextProject,
      selectedClipIds: normalizeSelection(nextProject, get().selectedClipIds),
    })
    get().scheduleSave()
  },

  deleteSelected: () => {
    const project = get().project
    if (!project) return
    const selected = new Set(get().selectedClipIds)
    if (selected.size === 0) return
    const next: VideoEditorProject = {
      ...project,
      clips: project.clips.filter((clip) => !selected.has(clip.id)),
      updatedAt: new Date().toISOString(),
    }
    set({
      past: withHistory(get().past, project),
      future: [],
      project: next,
      selectedClipIds: [],
    })
    get().scheduleSave()
  },

  duplicateSelected: () => {
    const project = get().project
    if (!project) return
    const selectedId = get().selectedClipIds[0]
    if (!selectedId) return
    const clip = project.clips.find((c) => c.id === selectedId)
    if (!clip) return
    const offset = clipEnd(clip) + 0.15
    const copy: TimelineClip = {
      ...clip,
      id: newClipId(),
      timelineStart: offset,
    }
    const next: VideoEditorProject = {
      ...project,
      clips: [...project.clips, copy],
      updatedAt: new Date().toISOString(),
    }
    set({
      past: withHistory(get().past, project),
      future: [],
      project: next,
      selectedClipIds: [copy.id],
      playhead: offset,
    })
    get().scheduleSave()
  },

  splitSelectedAtPlayhead: () => {
    const project = get().project
    if (!project) return
    const selectedId = get().selectedClipIds[0]
    if (!selectedId) return
    const clip = project.clips.find((c) => c.id === selectedId)
    if (!clip) return
    const split = splitClipAtPlayhead(clip, get().playhead, newClipId())
    if (!split) return
    const nextClips = project.clips.flatMap((existing) => {
      if (existing.id !== clip.id) return [existing]
      return split
    })
    const next: VideoEditorProject = {
      ...project,
      clips: nextClips,
      updatedAt: new Date().toISOString(),
    }
    set({
      past: withHistory(get().past, project),
      future: [],
      project: next,
      selectedClipIds: [split[1].id],
    })
    get().scheduleSave()
  },

  undo: () => {
    const past = get().past
    const project = get().project
    if (!project || past.length === 0) return
    const prev = past[past.length - 1]!
    set({
      project: prev,
      past: past.slice(0, -1),
      future: [project, ...get().future].slice(0, HISTORY_LIMIT),
      selectedClipIds: normalizeSelection(prev, get().selectedClipIds),
      playhead: Math.min(get().playhead, projectDuration(prev)),
    })
    get().scheduleSave()
  },

  redo: () => {
    const future = get().future
    const project = get().project
    if (!project || future.length === 0) return
    const next = future[0]!
    set({
      project: next,
      past: withHistory(get().past, project),
      future: future.slice(1),
      selectedClipIds: normalizeSelection(next, get().selectedClipIds),
      playhead: Math.min(get().playhead, projectDuration(next)),
    })
    get().scheduleSave()
  },

  setExportOpen: (exportOpen) => set({ exportOpen }),
  setExportMode: (exportMode) => set({ exportMode }),

  exportProject: async (destinationPath) => {
    ensureJobListener()
    const project = get().project
    if (!project) return
    set({ busy: true, error: null })
    try {
      const settings: EditorExportSettings = {
        mode: get().exportMode,
        destinationPath,
      }
      const job = await invoke<EditorJobProgress>("export_editor_project", {
        project,
        settings,
      })
      set({ job, exportOpen: false })
    } catch (error) {
      set({ error: String(error) })
    } finally {
      set({ busy: false })
    }
  },

  cancelExport: async () => {
    ensureJobListener()
    const job = get().job
    if (!job) return
    try {
      await invoke("cancel_editor_job", { jobId: job.jobId })
    } catch (error) {
      set({ error: String(error) })
    }
  },

  applyJob: (job) => {
    // Keep the latest job progress visible; exports can run even if the dialog closes.
    set({ job })
  },
}))

