import { CircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LiveIndicator } from "@/components/ui/live-indicator"
import { cn } from "@/lib/utils"
import { usePostProductionStore } from "@/stores/postproduction-store"
import { useStreamSessionStore } from "@/stores/stream-session-store"

export function ProgramRecordControls() {
  const live = useStreamSessionStore((state) => state.live)
  const pendingRecord = useStreamSessionStore((state) => state.pendingRecord)
  const activeVideoRecordingId = usePostProductionStore(
    (state) => state.activeVideoRecordingId,
  )
  const recording = pendingRecord || Boolean(activeVideoRecordingId)

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          "h-8 gap-1.5 px-2 text-[0.625rem] font-medium uppercase tracking-wider",
          recording && "text-red-400 hover:bg-red-500/10 hover:text-red-300",
        )}
        disabled={live}
        title={
          live
            ? "Stop the live stream to record from the projector"
            : recording
              ? "Stop video recording"
              : "Record program video"
        }
        onClick={() => {
          void useStreamSessionStore.getState().toggleProgramRecord()
        }}
      >
        <CircleIcon
          className={cn("size-3", recording && "fill-current text-red-400")}
        />
        {recording ? "Stop" : "Record"}
      </Button>
      <LiveIndicator
        active={recording}
        label="REC"
        title="Video recording"
      />
      <LiveIndicator
        active={live}
        label="STREAM"
        tone="emerald"
        title="Livestream"
      />
    </div>
  )
}
