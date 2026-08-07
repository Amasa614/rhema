import { useMemo } from "react"
import { useHymnStore } from "@/stores/hymn-store"
import type { VerseRenderData } from "@/types/broadcast"
import { hymnDisplayTitle } from "@/lib/hymn-display"

export function useHymnSlide(): VerseRenderData | null {
  const hymn = useHymnStore((state) => state.selectedHymn)
  const stanzaIndex = useHymnStore((state) => state.selectedStanzaIndex)

  return useMemo(() => {
    if (!hymn) return null
    const text = hymn.stanzas[stanzaIndex]
    if (!text) return null

    return {
      reference: `${hymn.number}. ${hymnDisplayTitle(hymn)}`,
      segments: [{ verseNumber: stanzaIndex + 1, text: text.replace(/\s+/g, " ") }],
    }
  }, [hymn, stanzaIndex])
}
