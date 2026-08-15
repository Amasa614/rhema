import { useEffect, useRef, useState, type RefObject } from "react"
import { CanvasVerse } from "@/components/ui/canvas-verse"
import { subscribeProgramCameraFrame } from "@/lib/program-camera-preview"
import {
  mixInsetRect,
  mixPanelPercent,
  mixSlideInset,
  mixSlideTheme,
  mixSplitLayout,
  type MixPanelRect,
} from "@/lib/mix-layout"
import {
  PROGRAM_LOOK_LABEL,
  programLookUsesCamera,
} from "@/lib/program-look"
import { cn } from "@/lib/utils"
import type { BroadcastTheme, VerseRenderData } from "@/types/broadcast"
import type { ProgramLook } from "@/types/stream"

function ThemeLogoOverlay({
  theme,
  dest,
}: {
  theme: BroadcastTheme
  dest?: MixPanelRect
}) {
  const logo = theme.logo
  if (!logo?.enabled || !logo.url) return null

  const boxW = dest?.width ?? theme.resolution.width
  const boxH = dest?.height ?? theme.resolution.height
  const pos = logo.position ?? "top-right"
  const marginX = `${(Math.max(0, logo.margin) / boxW) * 100}%`
  const marginY = `${(Math.max(0, logo.margin) / boxH) * 100}%`

  return (
    <img
      src={logo.url}
      alt=""
      className="pointer-events-none absolute h-auto max-h-[35%] object-contain"
      style={{
        width: `${logo.sizePercent}%`,
        opacity: logo.opacity ?? 1,
        ...(pos.startsWith("bottom") ? { bottom: marginY } : { top: marginY }),
        ...(pos.endsWith("left")
          ? { left: marginX }
          : pos.endsWith("center")
            ? { left: "50%", transform: "translateX(-50%)" }
            : { right: marginX }),
      }}
    />
  )
}

function MixSplitMonitor({
  theme,
  verse,
  cameraRef,
  hasFrame,
}: {
  theme: BroadcastTheme
  verse: VerseRenderData | null
  cameraRef: RefObject<HTMLImageElement | null>
  hasFrame: boolean
}) {
  const canvasW = theme.resolution.width
  const canvasH = theme.resolution.height
  const layout = mixSplitLayout(canvasW, canvasH)
  const cameraStyle = mixPanelPercent(layout.camera, canvasW, canvasH)
  const slideStyle = mixPanelPercent(layout.slide, canvasW, canvasH)
  const verseBox = mixInsetRect(layout.slide, mixSlideInset(layout.slide))
  const verseStyle = mixPanelPercent(verseBox, canvasW, canvasH)
  const slideTheme = mixSlideTheme(theme, verseBox)

  return (
    <div className="relative w-full" style={{ aspectRatio: `${canvasW} / ${canvasH}` }}>
      <div className="absolute inset-0 overflow-hidden rounded-md">
        <CanvasVerse theme={theme} verse={null} skipLogo />
      </div>
      <img
        ref={cameraRef}
        alt=""
        className={cn(
          "absolute rounded-sm object-cover shadow-[0_0_0_1.5px_rgba(255,255,255,0.45)]",
          !hasFrame && "bg-black",
        )}
        style={cameraStyle}
      />
      {theme.logo?.enabled && theme.logo.url ? (
        <div className="pointer-events-none absolute overflow-hidden" style={cameraStyle}>
          <ThemeLogoOverlay theme={theme} dest={layout.camera} />
        </div>
      ) : null}
      <div
        className="absolute overflow-hidden rounded-sm shadow-[0_0_0_1.5px_rgba(255,255,255,0.45)]"
        style={slideStyle}
      >
        {theme.logo?.enabled && theme.logo.url ? (
          <ThemeLogoOverlay theme={theme} dest={layout.slide} />
        ) : null}
      </div>
      <div className="absolute overflow-hidden" style={verseStyle}>
        <CanvasVerse theme={slideTheme} verse={verse} skipBackground />
      </div>
    </div>
  )
}

export function ProgramLookMonitor({
  theme,
  verse,
  look,
  className,
}: {
  theme: BroadcastTheme
  verse: VerseRenderData | null
  look: ProgramLook
  className?: string
}) {
  const cameraLook = programLookUsesCamera(look)
  const [hasFrame, setHasFrame] = useState(false)
  const frameRef = useRef<HTMLImageElement>(null)
  const lookRef = useRef(look)
  lookRef.current = look

  useEffect(() => {
    if (!cameraLook) {
      setHasFrame(false)
      const image = frameRef.current
      if (image) image.removeAttribute("src")
    }
  }, [cameraLook])

  useEffect(() => {
    return subscribeProgramCameraFrame((jpeg) => {
      if (!jpeg || !programLookUsesCamera(lookRef.current)) {
        const image = frameRef.current
        if (image) image.removeAttribute("src")
        setHasFrame((prev) => (prev ? false : prev))
        return
      }
      const image = frameRef.current
      if (image) image.src = jpeg
      setHasFrame((prev) => (prev ? prev : true))
    })
  }, [])

  const showVerse = look !== "camera"

  return (
    <div
      className={cn(
        "relative w-full",
        cameraLook && !hasFrame && look !== "mix" && "rounded-md bg-black",
        className,
      )}
    >
      {look === "mix" ? (
        <MixSplitMonitor
          theme={theme}
          verse={verse}
          cameraRef={frameRef}
          hasFrame={hasFrame}
        />
      ) : (
        <>
          <div className="relative w-full">
            <img
              ref={frameRef}
              alt=""
              className={cn(
                "w-full rounded-md object-cover",
                (!cameraLook || !hasFrame) && "hidden",
              )}
            />
            {look === "camera" && hasFrame && theme.logo?.enabled && theme.logo.url ? (
              <ThemeLogoOverlay theme={theme} />
            ) : null}
          </div>
          {showVerse || !hasFrame ? (
            <div
              className={cn(
                cameraLook && hasFrame && showVerse && "pointer-events-none absolute inset-0",
              )}
            >
              <CanvasVerse
                theme={theme}
                verse={showVerse ? verse : null}
                skipBackground={cameraLook}
                skipLogo={cameraLook}
              />
            </div>
          ) : null}
        </>
      )}
      {cameraLook ? (
        <span className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[0.625rem] font-medium tracking-wider text-sky-300 uppercase">
          {PROGRAM_LOOK_LABEL[look]}
        </span>
      ) : null}
    </div>
  )
}
