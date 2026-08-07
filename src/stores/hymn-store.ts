import { create } from "zustand"
import { load } from "@tauri-apps/plugin-store"
import { normalizeHymnText } from "@/lib/hymn-text"
import type { Hymn, HymnCollection } from "@/types/hymn"

export interface NewHymn {
  number?: number
  title: string
  author: string | null
  stanzas: string[]
}

interface HymnState {
  hymns: Hymn[]
  customHymns: Hymn[]
  attribution: string
  isLoading: boolean
  error: string | null
  selectedHymn: Hymn | null
  selectedStanzaIndex: number
  loadHymns: () => Promise<void>
  selectHymn: (hymn: Hymn) => void
  selectStanza: (index: number) => void
  clearSelection: () => void
  addCustomHymn: (hymn: NewHymn) => Promise<Hymn>
  deleteCustomHymn: (id: string) => Promise<void>
}

let loadPromise: Promise<void> | null = null

function sanitizeHymn(hymn: Hymn): Hymn {
  const traditions =
    hymn.traditions?.length > 0
      ? hymn.traditions
      : hymn.isCustom
        ? (["custom"] as const)
        : (["methodist"] as const)

  return {
    ...hymn,
    title: normalizeHymnText(hymn.title),
    author: hymn.author ? normalizeHymnText(hymn.author) : null,
    stanzas: hymn.stanzas.map(normalizeHymnText).filter(Boolean),
    sourceHymnal: hymn.sourceHymnal
      ? normalizeHymnText(hymn.sourceHymnal)
      : null,
    traditions: [...traditions],
  }
}

async function readCustomHymns(): Promise<Hymn[]> {
  try {
    const store = await load("hymns.json", { autoSave: false, defaults: {} })
    return (await store.get<Hymn[]>("customHymns") ?? []).map(sanitizeHymn)
  } catch {
    return []
  }
}

async function saveCustomHymns(hymns: Hymn[]): Promise<void> {
  const store = await load("hymns.json", { autoSave: false, defaults: {} })
  await store.set("customHymns", hymns)
  await store.save()
}

export const useHymnStore = create<HymnState>((set, get) => ({
  hymns: [],
  customHymns: [],
  attribution: "",
  isLoading: false,
  error: null,
  selectedHymn: null,
  selectedStanzaIndex: 0,

  loadHymns: async () => {
    if (get().hymns.length > 0) return
    if (loadPromise) return loadPromise

    set({ isLoading: true, error: null })
    loadPromise = Promise.all([
      fetch("/data/hymns-all.json"),
      readCustomHymns(),
    ])
      .then(async ([response, customHymns]) => {
        let collection: HymnCollection
        if (response.ok) {
          collection = (await response.json()) as HymnCollection
        } else {
          const fallback = await fetch("/data/methodist-hymns.json")
          if (!fallback.ok) {
            throw new Error(`Could not load hymns (${response.status})`)
          }
          collection = (await fallback.json()) as HymnCollection
        }
        const bundledHymns = collection.hymns.map(sanitizeHymn)
        const customWithTradition = customHymns.map((hymn) =>
          sanitizeHymn({ ...hymn, traditions: ["custom"] }),
        )
        set({
          hymns: [...customWithTradition, ...bundledHymns],
          customHymns: customWithTradition,
          attribution: collection.attribution,
          isLoading: false,
        })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Could not load hymns"
        set({ error: message, isLoading: false })
      })
      .finally(() => {
        loadPromise = null
      })

    return loadPromise
  },

  selectHymn: (selectedHymn) =>
    set({ selectedHymn, selectedStanzaIndex: 0 }),
  selectStanza: (selectedStanzaIndex) =>
    set((state) => {
      const maxIndex = Math.max(0, (state.selectedHymn?.stanzas.length ?? 1) - 1)
      return {
        selectedStanzaIndex: Math.min(Math.max(selectedStanzaIndex, 0), maxIndex),
      }
    }),
  clearSelection: () => set({ selectedHymn: null, selectedStanzaIndex: 0 }),
  addCustomHymn: async (input) => {
    await get().loadHymns()
    const state = get()
    const nextNumber = state.hymns.reduce(
      (maximum, hymn) => Math.max(maximum, hymn.number),
      0,
    ) + 1
    const hymn: Hymn = sanitizeHymn({
      id: `custom-${crypto.randomUUID()}`,
      number: input.number ?? nextNumber,
      title: input.title,
      author: input.author,
      stanzas: input.stanzas,
      sourceHymnal: "User added",
      sourceYear: new Date().getFullYear(),
      traditions: ["custom"],
      isCustom: true,
    })
    const customHymns = [hymn, ...state.customHymns]
    await saveCustomHymns(customHymns)
    set({ customHymns, hymns: [hymn, ...state.hymns] })
    return hymn
  },
  deleteCustomHymn: async (id) => {
    const state = get()
    const customHymns = state.customHymns.filter((hymn) => hymn.id !== id)
    await saveCustomHymns(customHymns)
    set({
      customHymns,
      hymns: state.hymns.filter((hymn) => hymn.id !== id),
      selectedHymn:
        state.selectedHymn?.id === id ? null : state.selectedHymn,
      selectedStanzaIndex:
        state.selectedHymn?.id === id ? 0 : state.selectedStanzaIndex,
    })
  },
}))
