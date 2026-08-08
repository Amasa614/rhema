import { useMemo } from "react"
import { useNotesStore } from "@/stores/notes-store"
import { buildNoteProjectionSlides } from "@/lib/note-slides"
import { formatProjectionLyrics } from "@/lib/hymn-text"
import type { VerseRenderData } from "@/types/broadcast"

export function useNoteSlide(): VerseRenderData | null {
  const note = useNotesStore((state) => state.selectedNote)
  const slideIndex = useNotesStore((state) => state.selectedSlideIndex)

  return useMemo(() => {
    if (!note) return null
    const slides = buildNoteProjectionSlides(note.body)
    const slide = slides[slideIndex]
    if (!slide) return null

    return {
      reference: slide.heading
        ? `${note.title} — ${slide.heading}`
        : note.title,
      segments: [{ text: formatProjectionLyrics(slide.text) }],
    }
  }, [note, slideIndex])
}
