import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useBroadcastStore } from "@/stores/broadcast-store"
import {
  useBibleStore,
  type OnScreenLanguageMode,
} from "@/stores/bible-store"
import type { VerseRenderData } from "@/types"
import type { Translation, Verse } from "@/types"

export type { OnScreenLanguageMode }

function translationAbbrev(
  translationId: number,
  translations: Translation[]
): string {
  return (
    translations.find((t) => t.id === translationId)?.abbreviation ?? "Bible"
  )
}

/** Primary translation only — sync helper for tests and simple paths. */
export function toVerseRenderData(
  verse: Verse,
  translation: string
): VerseRenderData {
  return {
    reference: `${verse.book_name} ${verse.chapter}:${verse.verse} (${translation})`,
    segments: [{ verseNumber: verse.verse, text: verse.text }],
  }
}

async function fetchVerseText(
  translationId: number,
  bookNumber: number,
  chapter: number,
  verse: number
): Promise<string> {
  const v = await invoke<Verse | null>("get_verse", {
    translationId,
    bookNumber,
    chapter,
    verse,
  })
  return v?.text ?? ""
}

/**
 * Build on-screen verse data from a reference, honoring Settings → Bible
 * (primary / companion / both). Always loads text from rhema.db by
 * book/chapter/verse — no machine translation.
 */
export async function buildVerseRenderData(
  ref: Pick<Verse, "book_number" | "book_name" | "chapter" | "verse">
): Promise<VerseRenderData> {
  const {
    activeTranslationId,
    companionTranslationId,
    onScreenLanguageMode,
    translations,
  } = useBibleStore.getState()

  const { book_number, book_name, chapter, verse } = ref
  const primaryId = activeTranslationId
  const companionId = companionTranslationId

  if (onScreenLanguageMode === "companion" && companionId != null) {
    const text = await fetchVerseText(
      companionId,
      book_number,
      chapter,
      verse
    )
    const abbr = translationAbbrev(companionId, translations)
    return {
      reference: `${book_name} ${chapter}:${verse} (${abbr})`,
      segments: [{ verseNumber: verse, text }],
    }
  }

  if (onScreenLanguageMode === "both" && companionId != null) {
    const [primaryText, companionText] = await Promise.all([
      fetchVerseText(primaryId, book_number, chapter, verse),
      fetchVerseText(companionId, book_number, chapter, verse),
    ])
    const pAbbr = translationAbbrev(primaryId, translations)
    const cAbbr = translationAbbrev(companionId, translations)
    return {
      reference: `${book_name} ${chapter}:${verse} (${pAbbr} · ${cAbbr})`,
      segments: [{ verseNumber: verse, text: primaryText }],
      companionSegments: [{ text: companionText }],
    }
  }

  const primaryText = await fetchVerseText(
    primaryId,
    book_number,
    chapter,
    verse
  )
  const abbr = translationAbbrev(primaryId, translations)
  return {
    reference: `${book_name} ${chapter}:${verse} (${abbr})`,
    segments: [{ verseNumber: verse, text: primaryText }],
  }
}

export async function presentVerseOnBroadcast(verse: Verse): Promise<void> {
  const data = await buildVerseRenderData(verse)
  useBroadcastStore.getState().setLiveVerse(data)
}

export function useVerseRenderData(verse: Verse | null): VerseRenderData | null {
  const activeTranslationId = useBibleStore((s) => s.activeTranslationId)
  const companionTranslationId = useBibleStore((s) => s.companionTranslationId)
  const onScreenLanguageMode = useBibleStore((s) => s.onScreenLanguageMode)
  const [data, setData] = useState<VerseRenderData | null>(null)

  useEffect(() => {
    if (!verse || verse.book_number <= 0) {
      setData(null)
      return
    }
    let cancelled = false
    void buildVerseRenderData(verse).then((next) => {
      if (!cancelled) setData(next)
    })
    return () => {
      cancelled = true
    }
  }, [
    verse?.book_number,
    verse?.chapter,
    verse?.verse,
    verse?.text,
    verse?.book_name,
    activeTranslationId,
    companionTranslationId,
    onScreenLanguageMode,
  ])

  return verse && verse.book_number > 0 ? data : null
}

export function deriveLiveVerse({
  isLive,
  selectedVerse,
  translation,
}: {
  isLive: boolean
  selectedVerse: Verse | null
  translation: string
}): VerseRenderData | null {
  if (!isLive || !selectedVerse) return null
  return toVerseRenderData(selectedVerse, translation)
}

export const broadcastActions = {
  setLiveVerse: (verse: VerseRenderData | null) =>
    useBroadcastStore.getState().setLiveVerse(verse),
  setLive: (live: boolean) => useBroadcastStore.getState().setLive(live),
  getActiveTheme: () => {
    const s = useBroadcastStore.getState()
    return s.themes.find((t) => t.id === s.activeThemeId) ?? s.themes[0]
  },
}
