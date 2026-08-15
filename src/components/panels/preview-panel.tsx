import { useEffect } from "react"
import { PanelHeader } from "@/components/ui/panel-header"
import { ProgramLookMonitor } from "@/components/broadcast/program-look-monitor"
import { LiveIndicator } from "@/components/ui/live-indicator"
import { useBibleStore, useBroadcastStore } from "@/stores"
import { bibleActions } from "@/hooks/use-bible"
import { useVerseRenderData } from "@/hooks/use-broadcast"
import { useHymnSlide } from "@/hooks/use-hymn-slide"
import { useNoteSlide } from "@/hooks/use-note-slide"
import {
  PROGRAM_LOOK_LABEL,
  programLookUsesCamera,
} from "@/lib/program-look"
import { useSettingsStore } from "@/stores/settings-store"

export function PreviewPanel() {
  const selectedVerse = useBibleStore((s) => s.selectedVerse)
  const activeTranslationId = useBibleStore((s) => s.activeTranslationId)
  const look = useSettingsStore((s) => s.streamProgramLook)
  const cameraLook = programLookUsesCamera(look)

  useEffect(() => {
    const verse = useBibleStore.getState().selectedVerse
    if (verse && verse.book_number > 0 && verse.chapter > 0 && verse.verse > 0) {
      bibleActions
        .fetchVerse(verse.book_number, verse.chapter, verse.verse)
        .then((v) => {
          if (v) bibleActions.selectVerse(v)
        })
        .catch(() => {})
    }
  }, [activeTranslationId])
  const themes = useBroadcastStore((s) => s.themes)
  const activeThemeId = useBroadcastStore((s) => s.activeThemeId)

  const activeTheme = themes.find((t) => t.id === activeThemeId) ?? themes[0]
  const renderedVerse = useVerseRenderData(selectedVerse)
  const hymnSlide = useHymnSlide()
  const noteSlide = useNoteSlide()
  const verseData = hymnSlide ?? noteSlide ?? renderedVerse

  return (
    <div
      data-slot="preview-panel"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
    >
      <PanelHeader title="Program preview">
        {cameraLook ? (
          <LiveIndicator
            active
            tone="sky"
            label={PROGRAM_LOOK_LABEL[look]}
            title="Program look — selected slide on camera"
          />
        ) : null}
      </PanelHeader>
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        <ProgramLookMonitor
          theme={activeTheme}
          verse={verseData}
          look={look}
        />
      </div>
    </div>
  )
}
