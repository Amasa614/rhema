import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings-store"
import { useStreamSessionStore } from "@/stores/stream-session-store"
import type { ProgramLook } from "@/types/stream"

const LOOKS: readonly {
  id: ProgramLook
  label: string
  title: string
}[] = [
  {
    id: "camera",
    label: "Camera",
    title: "Pastor camera only — no verses",
  },
  {
    id: "slides",
    label: "Slides",
    title: "Verses and hymns only",
  },
  {
    id: "mix",
    label: "Mix",
    title: "Camera beside verses",
  },
]

export function ProgramLookSwitch({
  className,
  compact = false,
}: {
  className?: string
  compact?: boolean
}) {
  const look = useSettingsStore((state) => state.streamProgramLook)

  return (
    <div
      role="group"
      aria-label="Program look"
      className={cn(
        "flex items-stretch overflow-hidden rounded-md border border-border bg-background p-0.5 shadow-xs",
        compact ? "h-8" : "h-9",
        className,
      )}
    >
      {LOOKS.map((option) => {
        const selected = look === option.id
        return (
          <button
            key={option.id}
            type="button"
            title={option.title}
            aria-pressed={selected}
            className={cn(
              "flex h-full min-h-0 min-w-0 flex-1 items-center justify-center rounded-[4px] px-2 leading-none font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
              compact
                ? "text-[0.625rem] uppercase tracking-wider"
                : "text-xs",
              selected
                ? "bg-sky-500/20 text-sky-100 ring-1 ring-inset ring-sky-400/35"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
            onClick={() => {
              if (option.id === look) return
              void useStreamSessionStore.getState().setProgramLook(option.id)
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
