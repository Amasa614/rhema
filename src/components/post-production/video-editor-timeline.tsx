import { useRef } from "react"

export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.0"
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  const whole = Math.floor(remainder)
  const tenth = Math.floor((remainder - whole) * 10)
  return `${minutes}:${String(whole).padStart(2, "0")}.${tenth}`
}

function tickStep(duration: number): number {
  if (duration > 180) return 30
  if (duration > 60) return 10
  if (duration > 20) return 5
  return 2
}

function timelineTicks(duration: number): number[] {
  const step = tickStep(duration)
  const ticks: number[] = []
  for (let time = 0; time <= duration + 0.001; time += step) {
    ticks.push(time)
  }
  return ticks
}

export function EditorTimeline({
  duration,
  currentTime,
  trimStart,
  trimEnd,
  clipLabel,
  onSeek,
  onChangeRange,
}: {
  duration: number
  currentTime: number
  trimStart: number
  trimEnd: number
  clipLabel: string
  onSeek: (time: number) => void
  onChangeRange: (start: number, end: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<"playhead" | "in" | "out" | "seek" | null>(null)
  const span = duration > 0 ? duration : 1
  const start = Math.min(trimStart, trimEnd)
  const end = Math.max(trimStart, trimEnd)
  const ticks = timelineTicks(span)
  const playhead = Math.min(span, Math.max(0, currentTime))

  const timeAtClientX = (clientX: number) => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return ratio * span
  }

  const applyDrag = (clientX: number) => {
    const time = timeAtClientX(clientX)
    const mode = dragRef.current
    if (mode === "playhead" || mode === "seek") {
      onSeek(time)
      return
    }
    if (mode === "in") {
      onChangeRange(Math.min(time, end - 0.05), end)
      onSeek(Math.min(time, end - 0.05))
      return
    }
    if (mode === "out") {
      onChangeRange(start, Math.max(time, start + 0.05))
      onSeek(Math.max(time, start + 0.05))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0c0e12]">
      <div className="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex w-14 shrink-0 flex-col border-r border-white/5 text-[0.625rem] text-muted-foreground">
          <div className="h-6 border-b border-white/5" />
          <div className="flex h-12 items-center justify-center border-b border-white/5 font-medium text-sky-300">
            V1
          </div>
          <div className="flex h-10 items-center justify-center font-medium text-emerald-300">
            A1
          </div>
        </div>
        <div className="min-w-0 flex-1 px-2 py-1">
          <div
            ref={trackRef}
            className="relative select-none"
            onPointerDown={(event) => {
              const target = event.target as HTMLElement
              const handle = target.closest("[data-handle]")?.getAttribute("data-handle")
              dragRef.current =
                handle === "in" || handle === "out" || handle === "playhead"
                  ? handle
                  : "seek"
              event.currentTarget.setPointerCapture(event.pointerId)
              applyDrag(event.clientX)
            }}
            onPointerMove={(event) => {
              if (!dragRef.current) return
              applyDrag(event.clientX)
            }}
            onPointerUp={() => {
              dragRef.current = null
            }}
          >
            <div className="relative h-6">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute top-0 text-[0.5625rem] text-muted-foreground/80"
                  style={{ left: `${(tick / span) * 100}%` }}
                >
                  {formatTimecode(tick)}
                </span>
              ))}
            </div>
            <div className="relative h-12 rounded-md bg-white/5">
              <div
                className="absolute inset-y-1 overflow-hidden rounded-sm bg-gradient-to-r from-sky-700 to-sky-500 shadow-sm"
                style={{ left: "0%", width: "100%" }}
              >
                <div className="flex h-full items-center px-2 text-[0.625rem] font-medium text-white">
                  <span className="truncate">{clipLabel}</span>
                </div>
              </div>
              <div
                className="pointer-events-none absolute inset-y-0 bg-amber-400/15"
                style={{
                  left: `${(start / span) * 100}%`,
                  width: `${((end - start) / span) * 100}%`,
                }}
              />
            </div>
            <div className="relative mt-1 h-10 rounded-md bg-white/5">
              <div className="absolute inset-y-1 left-0 right-0 overflow-hidden rounded-sm bg-gradient-to-r from-emerald-800 to-emerald-600">
                <div
                  className="h-full opacity-70"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(90deg, transparent 0, transparent 3px, rgba(255,255,255,0.18) 3px, rgba(255,255,255,0.18) 4px, transparent 4px, transparent 8px, rgba(255,255,255,0.35) 8px, rgba(255,255,255,0.35) 9px)",
                  }}
                />
              </div>
              <div
                className="pointer-events-none absolute inset-y-0 bg-amber-400/15"
                style={{
                  left: `${(start / span) * 100}%`,
                  width: `${((end - start) / span) * 100}%`,
                }}
              />
            </div>
            <button
              type="button"
              data-handle="in"
              className="absolute top-6 z-10 h-[5.5rem] w-1.5 -translate-x-1/2 cursor-ew-resize rounded-full bg-amber-300"
              style={{ left: `${(start / span) * 100}%` }}
              title="In point"
            />
            <button
              type="button"
              data-handle="out"
              className="absolute top-6 z-10 h-[5.5rem] w-1.5 -translate-x-1/2 cursor-ew-resize rounded-full bg-amber-300"
              style={{ left: `${(end / span) * 100}%` }}
              title="Out point"
            />
            <button
              type="button"
              data-handle="playhead"
              className="absolute top-0 z-20 h-[7.25rem] w-3 -translate-x-1/2 cursor-ew-resize bg-transparent"
              style={{ left: `${(playhead / span) * 100}%` }}
              title="Playhead"
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white" />
              <span className="absolute -top-0.5 left-1/2 size-2.5 -translate-x-1/2 rounded-sm bg-white" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
