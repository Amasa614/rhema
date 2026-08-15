import { lazy, Suspense, useState } from "react"
import { LevelMeter } from "@/components/ui/level-meter"
import { LiveIndicator } from "@/components/ui/live-indicator"
import {
  AudioLinesIcon,
  MicIcon,
  PaletteIcon,
  CastIcon,
  SunIcon,
  MoonIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { SettingsDialog } from "@/components/settings-dialog"
import { ThemeDesigner } from "@/components/broadcast/theme-designer"
import { BroadcastSettings } from "@/components/broadcast/broadcast-settings"
import { ProgramLookSwitch } from "@/components/controls/program-look-switch"
import { ProgramRecordControls } from "@/components/controls/program-record-controls"
import { useAudioStore, useTranscriptStore, useBroadcastStore } from "@/stores"
import { useTheme } from "@/components/theme-provider"
import { usePostProductionStore } from "@/stores/postproduction-store"
import { useStreamSessionStore } from "@/stores/stream-session-store"
import { cn } from "@/lib/utils"

const PostProductionWorkspace = lazy(() =>
  import("@/components/post-production/post-production-workspace").then(
    (module) => ({ default: module.PostProductionWorkspace }),
  ),
)

export function TransportBar() {
  const { theme, setTheme } = useTheme()
  const audioLevel = useAudioStore((s) => s.level)
  const isTranscribing = useTranscriptStore((s) => s.isTranscribing)
  const postProductionOpen = usePostProductionStore((s) => s.isOpen)
  const activeRecordingSessionId = usePostProductionStore(
    (s) => s.activeRecordingSessionId,
  )
  const activeVideoRecordingId = usePostProductionStore(
    (s) => s.activeVideoRecordingId,
  )
  const live = useStreamSessionStore((s) => s.live)
  const sermonRecording = Boolean(activeRecordingSessionId)
  const [broadcastOpen, setBroadcastOpen] = useState(false)

  return (
    <div
      data-slot="transport-bar"
      className="col-span-4 flex h-14 items-center justify-between border-b border-border  bg-card px-3"
    >
      <div className="flex items-center gap-2.5">
        <span className="text-sm font-semibold tracking-tight text-foreground">
          Rhema
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2" title="Transcription">
          <MicIcon className="size-3.5 text-muted-foreground" />
          <LevelMeter level={audioLevel.rms} bars={4} />
          <LiveIndicator active={isTranscribing} />
        </div>
        <div className="h-4 w-px bg-border" />
        <ProgramLookSwitch compact />
        <ProgramRecordControls />
        <Button
          variant="ghost"
          size="icon-sm"
          title="Toggle theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? (
            <SunIcon className="size-3.5" />
          ) : (
            <MoonIcon className="size-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={live ? "Broadcast — streaming" : "Broadcast Settings"}
          data-tour="broadcast"
          className="relative"
          onClick={() => setBroadcastOpen(true)}
        >
          <CastIcon
            className={cn("size-3.5", live && "text-emerald-400")}
          />
          {live ? (
            <span className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-emerald-400" />
          ) : null}
        </Button>
        <BroadcastSettings open={broadcastOpen} onOpenChange={setBroadcastOpen} />
        <Button
          variant="ghost"
          size="icon-sm"
          title="Theme Designer"
          data-tour="theme"
          onClick={() => useBroadcastStore.getState().setDesignerOpen(true)}
        >
          <PaletteIcon className="size-3.5" />
        </Button>
        <ThemeDesigner />
        <Button
          variant="ghost"
          size="icon-sm"
          title={
            sermonRecording
              ? "Post Production — recording sermon"
              : activeVideoRecordingId
                ? "Post Production — video"
                : "Post Production"
          }
          className="relative"
          onClick={() => {
            const store = usePostProductionStore.getState()
            if (store.activeVideoRecordingId && !store.activeRecordingSessionId) {
              store.openModule("video")
              return
            }
            store.setOpen(true)
          }}
        >
          <AudioLinesIcon
            className={cn(
              "size-3.5",
              sermonRecording ? "text-red-400" : "",
            )}
          />
          {sermonRecording ? (
            <span className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-red-400" />
          ) : null}
        </Button>
        {postProductionOpen ? (
          <Suspense fallback={null}>
            <PostProductionWorkspace />
          </Suspense>
        ) : null}
        <SettingsDialog />
      </div>
    </div>
  )
}
