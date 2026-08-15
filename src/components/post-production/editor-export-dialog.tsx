import { save } from "@tauri-apps/plugin-dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useVideoEditorStore } from "@/stores/video-editor-store"
import type { ExportMode } from "@/types/video-editor"

const MODES: { id: ExportMode; label: string; hint: string }[] = [
  {
    id: "videoAudio",
    label: "Video + Audio",
    hint: "Full program file with picture and sound",
  },
  {
    id: "videoOnly",
    label: "Video only",
    hint: "Picture without an audio track",
  },
  {
    id: "audioOnly",
    label: "Audio only",
    hint: "WAV export of the audible timeline",
  },
]

export function EditorExportDialog() {
  const open = useVideoEditorStore((state) => state.exportOpen)
  const mode = useVideoEditorStore((state) => state.exportMode)
  const job = useVideoEditorStore((state) => state.job)
  const busy = job?.status === "running" || job?.status === "queued"

  if (!open) return null

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-xl">
        <h2 className="text-base font-semibold">Export</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose what to render from the current timeline.
        </p>
        <div className="mt-4 space-y-2">
          {MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={cn(
                "w-full rounded-lg border p-3 text-left transition-colors",
                mode === option.id
                  ? "border-sky-500/50 bg-sky-500/10"
                  : "border-border hover:bg-muted/40",
              )}
              onClick={() =>
                useVideoEditorStore.getState().setExportMode(option.id)
              }
            >
              <p className="text-sm font-medium">{option.label}</p>
              <p className="text-[0.625rem] text-muted-foreground">
                {option.hint}
              </p>
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => useVideoEditorStore.getState().setExportOpen(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              void (async () => {
                const destination = await save({
                  filters:
                    mode === "audioOnly"
                      ? [{ name: "Audio", extensions: ["wav", "mp3"] }]
                      : [{ name: "Video", extensions: ["mp4"] }],
                  defaultPath:
                    mode === "audioOnly" ? "rhema-export.wav" : "rhema-export.mp4",
                })
                await useVideoEditorStore
                  .getState()
                  .exportProject(
                    typeof destination === "string" ? destination : undefined,
                  )
              })()
            }}
          >
            {busy ? "Exporting…" : "Export"}
          </Button>
        </div>
      </div>
    </div>
  )
}
