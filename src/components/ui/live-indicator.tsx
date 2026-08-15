import * as React from "react"

import { cn } from "@/lib/utils"

function LiveIndicator({
  className,
  active,
  label,
  tone = "destructive",
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  active: boolean
  label?: string
  tone?: "destructive" | "emerald" | "sky"
}) {
  const toneClass =
    tone === "emerald"
      ? {
          dot: "animate-pulse bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400",
          text: "text-emerald-400",
        }
      : tone === "sky"
        ? {
            dot: "animate-pulse bg-sky-400 shadow-[0_0_6px] shadow-sky-400",
            text: "text-sky-400",
          }
        : {
            dot: "animate-pulse bg-live-pulse shadow-[0_0_6px] shadow-live-pulse",
            text: "text-destructive",
          }
  return (
    <div
      data-slot="live-indicator"
      className={cn(
        "flex items-center gap-1.5 text-[0.625rem] font-medium uppercase tracking-wider",
        className
      )}
      {...props}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          active ? toneClass.dot : "bg-muted-foreground/40"
        )}
      />
      <span
        className={active ? toneClass.text : "text-muted-foreground"}
      >
        {label ?? (active ? "LIVE" : "OFF AIR")}
      </span>
    </div>
  )
}

export { LiveIndicator }
