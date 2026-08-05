import { create } from "zustand"
import { load } from "@tauri-apps/plugin-store"
import { invoke } from "@tauri-apps/api/core"
import type { Translation, Book, Verse, CrossReference } from "@/types"
import type { SemanticSearchResult } from "@/types/detection"

interface PendingNavigation {
  bookNumber: number
  chapter: number
  verse: number
}

/** What appears on program / live output for each verse reference. */
export type OnScreenLanguageMode = "primary" | "companion" | "both"

interface BibleState {
  translations: Translation[]
  activeTranslationId: number
  /** Second translation for bilingual output (e.g. TWI with English). */
  companionTranslationId: number | null
  onScreenLanguageMode: OnScreenLanguageMode
  books: Book[]
  searchResults: Verse[]
  semanticResults: SemanticSearchResult[]
  selectedVerse: Verse | null
  currentChapter: Verse[]
  crossReferences: CrossReference[]
  pendingNavigation: PendingNavigation | null

  setTranslations: (translations: Translation[]) => void
  setActiveTranslation: (id: number) => void
  setCompanionTranslationId: (id: number | null) => void
  setOnScreenLanguageMode: (mode: OnScreenLanguageMode) => void
  setBooks: (books: Book[]) => void
  setSearchResults: (results: Verse[]) => void
  setSemanticResults: (results: SemanticSearchResult[]) => void
  selectVerse: (verse: Verse | null) => void
  setCurrentChapter: (verses: Verse[]) => void
  setCrossReferences: (refs: CrossReference[]) => void
  setPendingNavigation: (nav: PendingNavigation | null) => void
}

export const useBibleStore = create<BibleState>((set) => ({
  translations: [],
  activeTranslationId: 1, // KJV default
  companionTranslationId: null,
  onScreenLanguageMode: "primary",
  books: [],
  searchResults: [],
  semanticResults: [],
  selectedVerse: null,
  currentChapter: [],
  crossReferences: [],
  pendingNavigation: null,

  setTranslations: (translations) => set({ translations }),
  setActiveTranslation: (activeTranslationId) => set({ activeTranslationId }),
  setCompanionTranslationId: (companionTranslationId) =>
    set({ companionTranslationId }),
  setOnScreenLanguageMode: (onScreenLanguageMode) =>
    set({ onScreenLanguageMode }),
  setBooks: (books) => set({ books }),
  setSearchResults: (searchResults) => set({ searchResults }),
  setSemanticResults: (semanticResults) => set({ semanticResults }),
  selectVerse: (selectedVerse) => set({ selectedVerse }),
  setCurrentChapter: (currentChapter) => set({ currentChapter }),
  setCrossReferences: (crossReferences) => set({ crossReferences }),
  setPendingNavigation: (pendingNavigation) => set({ pendingNavigation }),
}))

/** Load persisted activeTranslationId from disk into Zustand, then sync to Rust backend. */
export async function hydrateBibleStore(): Promise<void> {
  try {
    const store = await load("bible.json", { autoSave: false, defaults: {} })
    const value = await store.get<number>("activeTranslationId")
    if (typeof value === "number") {
      useBibleStore.getState().setActiveTranslation(value)
    }
    const companion = await store.get<number | null>("companionTranslationId")
    if (companion === null || typeof companion === "number") {
      useBibleStore.getState().setCompanionTranslationId(companion ?? null)
    }
    const screenMode = await store.get<OnScreenLanguageMode>("onScreenLanguageMode")
    if (
      screenMode === "primary" ||
      screenMode === "companion" ||
      screenMode === "both"
    ) {
      useBibleStore.getState().setOnScreenLanguageMode(screenMode)
    }
    await invoke("set_active_translation", {
      translationId: useBibleStore.getState().activeTranslationId,
    })
  } catch {
    console.warn("[bible] Failed to hydrate bible store, using defaults")
  }
}

/** Subscribe to activeTranslationId changes and persist to disk with debounce. */
export async function initBiblePersistence(): Promise<void> {
  try {
    const store = await load("bible.json", { autoSave: false, defaults: {} })
    let timer: ReturnType<typeof setTimeout> | null = null
    let prev = useBibleStore.getState().activeTranslationId
    let prevCompanion = useBibleStore.getState().companionTranslationId
    let prevScreenMode = useBibleStore.getState().onScreenLanguageMode

    useBibleStore.subscribe((state) => {
      const id = state.activeTranslationId
      const companion = state.companionTranslationId
      const screenMode = state.onScreenLanguageMode
      if (
        id === prev &&
        companion === prevCompanion &&
        screenMode === prevScreenMode
      ) {
        return
      }
      prev = id
      prevCompanion = companion
      prevScreenMode = screenMode
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        await store.set("activeTranslationId", id)
        await store.set("companionTranslationId", companion)
        await store.set("onScreenLanguageMode", screenMode)
        await store.save()
      }, 500)
    })
  } catch {
    console.warn("[bible] Failed to init persistence subscription")
  }
}
