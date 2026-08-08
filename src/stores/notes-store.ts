import { create } from "zustand"
import { load } from "@tauri-apps/plugin-store"
import { useHymnStore } from "@/stores/hymn-store"
import { buildNoteProjectionSlides } from "@/lib/note-slides"
import type { NewSermonNote, SermonNote } from "@/types/note"

interface NotesState {
  notes: SermonNote[]
  isLoading: boolean
  error: string | null
  selectedNote: SermonNote | null
  selectedSlideIndex: number
  loadNotes: () => Promise<void>
  selectNote: (note: SermonNote) => void
  selectSlide: (index: number) => void
  clearSelection: () => void
  addNote: (input: NewSermonNote) => Promise<SermonNote>
  updateNote: (id: string, input: Partial<NewSermonNote>) => Promise<void>
  deleteNote: (id: string) => Promise<void>
}

let loadPromise: Promise<void> | null = null

function normalizeNote(note: SermonNote): SermonNote {
  return {
    ...note,
    title: note.title.trim(),
    body: note.body.trim(),
  }
}

async function readNotes(): Promise<SermonNote[]> {
  try {
    const store = await load("notes.json", { autoSave: false, defaults: {} })
    return ((await store.get<SermonNote[]>("notes")) ?? []).map(normalizeNote)
  } catch {
    return []
  }
}

async function saveNotes(notes: SermonNote[]): Promise<void> {
  const store = await load("notes.json", { autoSave: false, defaults: {} })
  await store.set("notes", notes)
  await store.save()
}

export function noteSlides(body: string): string[] {
  return buildNoteProjectionSlides(body).map((slide) =>
    [slide.heading, slide.text].filter(Boolean).join("\n")
  )
}

export const useNotesStore = create<NotesState>((set, get) => ({
  notes: [],
  isLoading: false,
  error: null,
  selectedNote: null,
  selectedSlideIndex: 0,

  loadNotes: async () => {
    if (loadPromise) return loadPromise

    set({ isLoading: true, error: null })
    loadPromise = readNotes()
      .then((notes) => {
        notes.sort((a, b) => b.updatedAt - a.updatedAt)
        set({ notes, isLoading: false })
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Could not load notes"
        set({ error: message, isLoading: false })
      })
      .finally(() => {
        loadPromise = null
      })

    return loadPromise
  },

  selectNote: (selectedNote) => {
    useHymnStore.getState().clearSelection()
    set({ selectedNote, selectedSlideIndex: 0 })
  },

  selectSlide: (selectedSlideIndex) =>
    set((state) => {
      const slides = state.selectedNote
        ? noteSlides(state.selectedNote.body)
        : [""]
      const maxIndex = Math.max(0, slides.length - 1)
      return {
        selectedSlideIndex: Math.min(Math.max(selectedSlideIndex, 0), maxIndex),
      }
    }),

  clearSelection: () => set({ selectedNote: null, selectedSlideIndex: 0 }),

  addNote: async (input) => {
    const note: SermonNote = normalizeNote({
      id: crypto.randomUUID(),
      title: input.title.trim() || "Untitled note",
      body: input.body,
      updatedAt: Date.now(),
    })
    const notes = [note, ...get().notes]
    await saveNotes(notes)
    set({ notes })
    return note
  },

  updateNote: async (id, input) => {
    const notes = get().notes.map((note) => {
      if (note.id !== id) return note
      return normalizeNote({
        ...note,
        title:
          input.title !== undefined
            ? input.title.trim() || "Untitled note"
            : note.title,
        body: input.body !== undefined ? input.body : note.body,
        updatedAt: Date.now(),
      })
    })
    await saveNotes(notes)
    const selectedNote = get().selectedNote
    const nextSelectedNote =
      selectedNote?.id === id
        ? (notes.find((note) => note.id === id) ?? null)
        : selectedNote
    const maxSlideIndex = nextSelectedNote
      ? Math.max(0, noteSlides(nextSelectedNote.body).length - 1)
      : 0
    set({
      notes,
      selectedNote: nextSelectedNote,
      selectedSlideIndex: Math.min(get().selectedSlideIndex, maxSlideIndex),
    })
  },

  deleteNote: async (id) => {
    const notes = get().notes.filter((note) => note.id !== id)
    await saveNotes(notes)
    const selectedNote = get().selectedNote
    set({
      notes,
      selectedNote: selectedNote?.id === id ? null : selectedNote,
      selectedSlideIndex:
        selectedNote?.id === id ? 0 : get().selectedSlideIndex,
    })
  },
}))
