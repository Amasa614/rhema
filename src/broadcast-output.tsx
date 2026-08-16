import { createRoot } from "react-dom/client"
import { useRef, useEffect, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"
import { mixCoverFit, mixInsetRect, mixSlideInset, mixSlideTheme, mixSplitLayout } from "@/lib/mix-layout"
import { programLookFromCameraUnderlay, programLookUsesCamera } from "@/lib/program-look"
import { drawVideoCover, getCameraStream, getRecordAudioStream, mixCanvasAndAudio, pickRecorderMime, streamHasLiveAudio } from "@/lib/projector-camera"
import { drawThemeLogo, renderVerse } from "@/lib/verse-renderer"
import type { BroadcastTheme, VerseRenderData } from "@/types/broadcast"
import type { CameraUnderlayPayload, NdiConfigEventPayload, NdiFrameRequest, ProgramLook, ProgramLookPayload, ProgramPreviewPayload } from "@/types"

/** Convert Uint8Array/Uint8ClampedArray to base64 using Function.apply (avoids spread stack overflow) */
function uint8ToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  const CHUNK = 0x8000 // 32KB — safe for Function.apply
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(
      String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + CHUNK) as unknown as number[],
      ),
    )
  }
  return btoa(parts.join(""))
}

function strokeMixPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.save()
  ctx.strokeStyle = "rgba(255,255,255,0.55)"
  ctx.lineWidth = Math.max(2, Math.round(height * 0.003))
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, radius)
  ctx.stroke()
  ctx.restore()
}

function drawMixSplit(
  ctx: CanvasRenderingContext2D,
  theme: BroadcastTheme,
  verse: VerseRenderData | null,
  video: HTMLVideoElement | null,
  imageCache: Map<string, HTMLImageElement>,
) {
  const { camera, slide, radius } = mixSplitLayout(
    theme.resolution.width,
    theme.resolution.height,
  )
  renderVerse(ctx, theme, null, { scale: 1, imageCache, skipLogo: true })

  ctx.save()
  ctx.beginPath()
  ctx.roundRect(camera.x, camera.y, camera.width, camera.height, radius)
  ctx.clip()
  if (video) {
    drawVideoCover(ctx, video, camera.width, camera.height, camera.x, camera.y)
  } else {
    ctx.fillStyle = "#000"
    ctx.fillRect(camera.x, camera.y, camera.width, camera.height)
  }
  ctx.restore()
  drawThemeLogo(ctx, theme, imageCache, camera)

  const tw = theme.resolution.width
  const th = theme.resolution.height
  const bgFit = mixCoverFit(tw, th, slide)
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(slide.x, slide.y, slide.width, slide.height, radius)
  ctx.clip()
  ctx.translate(bgFit.offsetX, bgFit.offsetY)
  renderVerse(ctx, theme, null, { scale: bgFit.scale, imageCache, skipLogo: true })
  ctx.restore()

  const verseBox = mixInsetRect(slide, mixSlideInset(slide))
  const slideTheme = mixSlideTheme(theme, verseBox)
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(slide.x, slide.y, slide.width, slide.height, radius)
  ctx.clip()
  ctx.translate(verseBox.x, verseBox.y)
  renderVerse(ctx, slideTheme, verse, {
    scale: 1,
    imageCache,
    skipBackground: true,
  })
  ctx.restore()
  drawThemeLogo(ctx, theme, imageCache, slide)

  strokeMixPanel(ctx, camera.x, camera.y, camera.width, camera.height, radius)
  strokeMixPanel(ctx, slide.x, slide.y, slide.width, slide.height, radius)
}

/** The window label is reliable for both packaged app assets and the dev server. */
const OUTPUT_ID = getCurrentWebviewWindow().label === "broadcast-alt" ? "alt" : "main"

interface BroadcastPayload {
  theme: BroadcastTheme
  verse: VerseRenderData | null
}

interface BroadcastSnapshot {
  version: number
  payload: BroadcastPayload
}

function BroadcastCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const latestData = useRef<BroadcastPayload | null>(null)
  const latestVersion = useRef(0)
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const ndiConfigRef = useRef<NdiConfigEventPayload>({
    active: false,
    fps: 24,
    width: 1920,
    height: 1080,
  })
  const ndiCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastPushRef = useRef(0)
  const pushingRef = useRef(false)
  const lastNdiWarnRef = useRef(0)
  const lastOverlayWarnRef = useRef(0)
  const ndiBurstTimersRef = useRef<number[]>([])
  const streamOverlayRef = useRef(false)
  const overlayPushingRef = useRef(false)
  const lastOverlayPushRef = useRef(0)
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const previewPushingRef = useRef(false)
  const lastPreviewRef = useRef(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingRef = useRef(false)
  const pendingAppendsRef = useRef<Promise<unknown>[]>([])
  const cameraRef = useRef<{
    look: ProgramLook
    generation: number
    deviceLabel: string
    stream: MediaStream | null
    video: HTMLVideoElement | null
    raf: number
  }>({
    look: "slides",
    generation: 0,
    deviceLabel: "",
    stream: null,
    video: null,
    raf: 0,
  })

  const logDebug = useCallback((message: string, meta?: unknown) => {
    if (!import.meta.env.DEV) return
    if (meta === undefined) {
      console.debug(`[broadcast-output] ${message}`)
      return
    }
    console.debug(`[broadcast-output] ${message}`, meta)
  }, [])

  const emitProgramPreview = useCallback((jpeg: string | null) => {
    if (OUTPUT_ID !== "main") return
    const payload: ProgramPreviewPayload = {
      look: cameraRef.current.look,
      jpeg,
    }
    void getCurrentWebviewWindow().emitTo("main", "broadcast:program-preview", payload)
  }, [])

  const pushProgramPreview = useCallback(() => {
    if (OUTPUT_ID !== "main") return
    if (!programLookUsesCamera(cameraRef.current.look)) return
    if (previewPushingRef.current) return
    const now = Date.now()
    if (now - lastPreviewRef.current < 200) return
    const canvas = canvasRef.current
    if (!canvas || canvas.width === 0) return
    previewPushingRef.current = true
    lastPreviewRef.current = now
    try {
      const maxW = 640
      const scale = Math.min(1, maxW / canvas.width)
      const width = Math.max(1, Math.round(canvas.width * scale))
      const height = Math.max(1, Math.round(canvas.height * scale))
      const preview = previewCanvasRef.current ?? document.createElement("canvas")
      if (preview.width !== width) preview.width = width
      if (preview.height !== height) preview.height = height
      previewCanvasRef.current = preview
      const ctx = preview.getContext("2d")
      if (!ctx) {
        previewPushingRef.current = false
        return
      }
      ctx.drawImage(canvas, 0, 0, width, height)
      void getCurrentWebviewWindow()
        .emitTo("main", "broadcast:program-preview", {
          look: cameraRef.current.look,
          jpeg: preview.toDataURL("image/jpeg", 0.7),
        } satisfies ProgramPreviewPayload)
        .finally(() => {
          previewPushingRef.current = false
        })
    } catch {
      previewPushingRef.current = false
    }
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const data = latestData.current
    const theme = data?.theme
    const verse = data?.verse ?? null
    const width = theme?.resolution.width ?? 1920
    const height = theme?.resolution.height ?? 1080
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    const look = cameraRef.current.look
    const video = cameraRef.current.video
    const videoReady = Boolean(
      video && video.readyState >= 2 && video.videoWidth > 0,
    )

    if (programLookUsesCamera(look)) {
      if (videoReady && video) {
        drawVideoCover(ctx, video, canvas.width, canvas.height)
      } else {
        ctx.fillStyle = "#000"
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
      pushProgramPreview()
      if (look === "mix" && theme) {
        drawMixSplit(
          ctx,
          theme,
          verse,
          videoReady ? video : null,
          imageCacheRef.current,
        )
      } else if (theme) {
        drawThemeLogo(ctx, theme, imageCacheRef.current)
      }
      return
    }

    if (!theme) {
      ctx.fillStyle = "#000"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      return
    }

    const result = renderVerse(ctx, theme, verse, {
      scale: 1,
      imageCache: imageCacheRef.current,
    })
    if (!result) {
      ctx.fillStyle = "#000"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      logDebug("renderVerse returned null; drew fallback frame")
    }
  }, [logDebug, pushProgramPreview])

  const preloadThemeImages = useCallback((theme: BroadcastTheme) => {
    const urls: string[] = []
    if (theme.background.type === "image" && theme.background.image?.url) {
      urls.push(theme.background.image.url)
    }
    if (theme.logo?.url) urls.push(theme.logo.url)

    const cache = imageCacheRef.current
    for (const url of urls) {
      if (cache.has(url)) continue
      const img = new Image()
      img.onload = () => {
        cache.set(url, img)
        logDebug("Theme image loaded", { url })
        draw()
      }
      img.onerror = () => {
        console.warn("[broadcast-output] failed to load theme image", { url })
      }
      img.src = url
    }
  }, [draw, logDebug])

  const applySnapshot = useCallback((snapshot: BroadcastSnapshot) => {
    if (snapshot.version < latestVersion.current) return
    latestVersion.current = snapshot.version
    latestData.current = snapshot.payload
    preloadThemeImages(snapshot.payload.theme)
    logDebug("Applied broadcast snapshot", {
      version: snapshot.version,
      hasVerse: Boolean(snapshot.payload.verse),
      themeId: snapshot.payload.theme.id,
    })
    draw()
  }, [draw, logDebug, preloadThemeImages])

  const pushNdiFrame = useCallback(async () => {
    if (!ndiConfigRef.current.active) return
    if (pushingRef.current) return // back-pressure: skip if already pushing
    pushingRef.current = true

    try {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext("2d")
      if (!ctx) return

      const targetWidth = ndiConfigRef.current.width
      const targetHeight = ndiConfigRef.current.height

      let sourceCtx = ctx
      let sourceWidth = canvas.width
      let sourceHeight = canvas.height

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        const ndiCanvas = ndiCanvasRef.current ?? document.createElement("canvas")
        ndiCanvas.width = targetWidth
        ndiCanvas.height = targetHeight
        const ndiCtx = ndiCanvas.getContext("2d")
        if (!ndiCtx) return
        ndiCtx.drawImage(canvas, 0, 0, targetWidth, targetHeight)
        ndiCanvasRef.current = ndiCanvas
        sourceCtx = ndiCtx
        sourceWidth = targetWidth
        sourceHeight = targetHeight
      }

      const imageData = sourceCtx.getImageData(0, 0, sourceWidth, sourceHeight)
      const rgbaBase64 = uint8ToBase64(imageData.data)

      const request: NdiFrameRequest = {
        outputId: OUTPUT_ID,
        width: sourceWidth,
        height: sourceHeight,
        rgbaBase64,
      }

      await invoke("push_ndi_frame", { request })
      lastPushRef.current = Date.now()
    } catch (error) {
      const now = Date.now()
      if (now - lastNdiWarnRef.current > 5000) {
        lastNdiWarnRef.current = now
        console.warn("[broadcast-output] push_ndi_frame failed", error)
      }
    } finally {
      pushingRef.current = false
    }
  }, [])

  const pushStreamOverlay = useCallback(async () => {
    if (!streamOverlayRef.current || OUTPUT_ID !== "main") return
    if (overlayPushingRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    overlayPushingRef.current = true
    try {
      const pngBase64 = canvas.toDataURL("image/jpeg", 0.8)
      await invoke("push_stream_overlay", { pngBase64 })
    } catch (error) {
      const now = Date.now()
      if (now - lastOverlayWarnRef.current > 5000) {
        lastOverlayWarnRef.current = now
        console.warn("[broadcast-output] push_stream_overlay failed", error)
      }
    } finally {
      overlayPushingRef.current = false
    }
  }, [])

  /** Push a burst of 3 frames after content changes (NDI receivers need a few frames to sync) */
  const pushNdiBurst = useCallback(() => {
    void pushNdiFrame()
    void pushStreamOverlay()
    ndiBurstTimersRef.current.push(
      window.setTimeout(() => void pushNdiFrame(), 150),
      window.setTimeout(() => void pushNdiFrame(), 300),
    )
  }, [pushNdiFrame, pushStreamOverlay])

  const stopCameraLoop = useCallback(() => {
    if (cameraRef.current.raf) {
      cancelAnimationFrame(cameraRef.current.raf)
      cameraRef.current.raf = 0
    }
  }, [])

  const stopCameraTracks = useCallback(() => {
    if (!recordingRef.current) {
      stopCameraLoop()
    }
    const video = cameraRef.current.video
    if (video) {
      video.pause()
      video.srcObject = null
    }
    cameraRef.current.stream?.getTracks().forEach((track) => track.stop())
    cameraRef.current.stream = null
    cameraRef.current.video = null
  }, [stopCameraLoop])

  const startCameraLoop = useCallback(() => {
    const tick = () => {
      const keepGoing =
        recordingRef.current || programLookUsesCamera(cameraRef.current.look)
      if (!keepGoing) {
        cameraRef.current.raf = 0
        return
      }
      draw()
      if (streamOverlayRef.current) {
        const now = Date.now()
        if (now - lastOverlayPushRef.current >= 100) {
          lastOverlayPushRef.current = now
          void pushStreamOverlay()
        }
      }
      cameraRef.current.raf = requestAnimationFrame(tick)
    }
    if (!cameraRef.current.raf) {
      cameraRef.current.raf = requestAnimationFrame(tick)
    }
  }, [draw, pushStreamOverlay])

  const applyProgramLook = useCallback(
    async (payload: ProgramLookPayload) => {
      const look = payload.look
      const deviceLabel = payload.deviceLabel?.trim() ?? ""
      cameraRef.current.look = look

      if (payload.releaseCamera) {
        cameraRef.current.generation += 1
        cameraRef.current.deviceLabel = ""
        stopCameraTracks()
        draw()
        emitProgramPreview(null)
        if (streamOverlayRef.current) void pushStreamOverlay()
        return
      }

      if (!programLookUsesCamera(look) || !deviceLabel) {
        cameraRef.current.generation += 1
        cameraRef.current.deviceLabel = ""
        stopCameraTracks()
        draw()
        emitProgramPreview(null)
        if (streamOverlayRef.current) void pushStreamOverlay()
        return
      }

      if (
        cameraRef.current.stream &&
        cameraRef.current.deviceLabel === deviceLabel
      ) {
        startCameraLoop()
        draw()
        if (streamOverlayRef.current) void pushStreamOverlay()
        return
      }

      const generation = cameraRef.current.generation + 1
      cameraRef.current.generation = generation
      cameraRef.current.deviceLabel = deviceLabel
      stopCameraTracks()
      startCameraLoop()

      try {
        const stream = await getCameraStream(deviceLabel)
        if (cameraRef.current.generation !== generation) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        const video = document.createElement("video")
        video.muted = true
        video.playsInline = true
        video.autoplay = true
        video.srcObject = new MediaStream(stream.getVideoTracks())
        await video.play()
        if (cameraRef.current.generation !== generation) {
          video.pause()
          video.srcObject = null
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        cameraRef.current.stream = stream
        cameraRef.current.video = video
        if (programLookUsesCamera(cameraRef.current.look)) {
          startCameraLoop()
        } else {
          draw()
        }
      } catch (error) {
        if (cameraRef.current.generation !== generation) return
        cameraRef.current.look = "slides"
        cameraRef.current.deviceLabel = ""
        stopCameraTracks()
        draw()
        emitProgramPreview(null)
        const message = error instanceof Error ? error.message : String(error)
        void getCurrentWebviewWindow().emitTo("main", "broadcast:camera-error", {
          error: message,
        })
        logDebug("camera underlay failed", message)
      }
    },
    [draw, emitProgramPreview, logDebug, pushStreamOverlay, startCameraLoop, stopCameraTracks],
  )

  const stopProgramRecorder = useCallback(async () => {
    recordingRef.current = false
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true })
        try {
          recorder.requestData()
        } catch {
          // Some WebView builds throw if no data is buffered yet.
        }
        recorder.stop()
      })
    }
    await Promise.all(pendingAppendsRef.current)
    pendingAppendsRef.current = []
    await invoke("video_recording_stop").catch(() => {})
  }, [])

  const startProgramRecorder = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas) {
      throw new Error("Projector canvas is not ready")
    }
    await stopProgramRecorder()
    const mimeType = pickRecorderMime()
    const extension = mimeType.includes("mp4") ? "mp4" : "webm"
    await invoke("video_recording_start", { extension })
    let audioSource = cameraRef.current.stream
    if (!streamHasLiveAudio(audioSource)) {
      const extra = await getRecordAudioStream(cameraRef.current.deviceLabel)
      if (extra) {
        if (audioSource) {
          for (const track of extra.getAudioTracks()) {
            audioSource.addTrack(track)
          }
        } else {
          audioSource = extra
        }
      }
    }
    recordingRef.current = true
    startCameraLoop()
    draw()
    const mixed = mixCanvasAndAudio(canvas, audioSource)
    if (!mixed.getVideoTracks().some((track) => track.readyState === "live")) {
      recordingRef.current = false
      throw new Error("Could not capture program video from the projector")
    }
    if (!streamHasLiveAudio(mixed)) {
      console.warn("[broadcast-output] recording without an audio track")
    }
    const recorder = new MediaRecorder(
      mixed,
      mimeType
        ? { mimeType, videoBitsPerSecond: 4_500_000 }
        : { videoBitsPerSecond: 4_500_000 },
    )
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0) return
      const job = event.data
        .arrayBuffer()
        .then((buffer) => {
          const chunkBase64 = uint8ToBase64(new Uint8Array(buffer))
          return invoke("video_recording_append", { chunkBase64 })
        })
        .catch((error) => {
          console.warn("[broadcast-output] video_recording_append failed", error)
        })
      pendingAppendsRef.current.push(job)
    })
    recorder.start(1000)
    recorderRef.current = recorder
  }, [draw, startCameraLoop, stopProgramRecorder])

  useEffect(() => {
    // Set initial canvas size
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = 1920
      canvas.height = 1080
      const ctx = canvas.getContext("2d")
      if (ctx) {
        ctx.fillStyle = "#000"
        ctx.fillRect(0, 0, 1920, 1080)
      }
    }

    const currentWindow = getCurrentWebviewWindow()
    logDebug("Listener registration started", { label: currentWindow.label })
    let disposed = false
    let removeListeners: (() => void) | null = null

    const registerListeners = async () => {
      const [
        unlistenVerse,
        unlistenNdiConfig,
        unlistenStreamOverlay,
        unlistenProgramLook,
        unlistenCamera,
        unlistenRecord,
      ] = await Promise.all([
        currentWindow.listen<BroadcastSnapshot>("broadcast:snapshot-update", (event) => {
          applySnapshot(event.payload)
          pushNdiBurst()
        }),
        currentWindow.listen<NdiConfigEventPayload>("broadcast:ndi-config", (event) => {
          ndiConfigRef.current = event.payload
          logDebug("Received broadcast:ndi-config", event.payload)
          if (event.payload.active) pushNdiBurst()
        }),
        currentWindow.listen<{ active?: boolean }>("broadcast:stream-overlay", (event) => {
          streamOverlayRef.current = Boolean(event.payload.active)
          if (streamOverlayRef.current) void pushStreamOverlay()
          void currentWindow.emitTo("main", "broadcast:stream-overlay-ready", {
            outputId: OUTPUT_ID,
            active: streamOverlayRef.current,
          })
        }),
        currentWindow.listen<ProgramLookPayload>("broadcast:program-look", (event) => {
          logDebug("Received broadcast:program-look", event.payload)
          void applyProgramLook(event.payload).then(() => {
            if (event.payload.releaseCamera) {
              void currentWindow.emitTo("main", "broadcast:camera-released", {
                outputId: OUTPUT_ID,
              })
            }
          })
        }),
        currentWindow.listen<CameraUnderlayPayload>("broadcast:camera-underlay", (event) => {
          logDebug("Received broadcast:camera-underlay", event.payload)
          void applyProgramLook(programLookFromCameraUnderlay(
            event.payload.active,
            event.payload.deviceLabel,
          ))
        }),
        currentWindow.listen<{ active?: boolean }>("broadcast:record", (event) => {
          logDebug("Received broadcast:record", event.payload)
          if (event.payload.active) {
            void startProgramRecorder().catch((error) => {
              void currentWindow.emitTo("main", "broadcast:record-error", {
                error: error instanceof Error ? error.message : String(error),
              })
            })
          } else {
            void stopProgramRecorder()
          }
        }),
      ])

      if (disposed) {
        unlistenVerse()
        unlistenNdiConfig()
        unlistenStreamOverlay()
        unlistenProgramLook()
        unlistenCamera()
        unlistenRecord()
        return
      }

      removeListeners = () => {
        unlistenVerse()
        unlistenNdiConfig()
        unlistenStreamOverlay()
        unlistenProgramLook()
        unlistenCamera()
        unlistenRecord()
      }

      // Pull durable state after listeners register. If an update races with
      // this request, version ordering prevents an older snapshot winning.
      const snapshot = await invoke<BroadcastSnapshot | null>(
        "get_broadcast_snapshot",
        { outputId: OUTPUT_ID },
      )
      if (snapshot) {
        applySnapshot(snapshot)
        pushNdiBurst()
      }

      await currentWindow.emitTo("main", "broadcast:output-ready", {
        outputId: OUTPUT_ID,
      })
      logDebug("Sent broadcast:output-ready")
    }

    void registerListeners().catch((error) => {
      console.error("[broadcast-output] failed to initialize event listeners", error)
    })

    // Request current NDI status on mount (fixes race condition
    // where NDI is started before this window opens)
    void invoke<{ active: boolean; width: number; height: number; fps: number } | null>("get_ndi_status", { outputId: OUTPUT_ID })
      .then((status) => {
        if (status && status.active) {
          ndiConfigRef.current = {
            active: true,
            fps: status.fps,
            width: status.width,
            height: status.height,
          }
          logDebug("Fetched NDI status on mount", status)
        }
      })
      .catch(() => {
        // Command may not exist yet
      })

    return () => {
      disposed = true
      removeListeners?.()
      for (const timer of ndiBurstTimersRef.current) {
        clearTimeout(timer)
      }
      ndiBurstTimersRef.current = []
      cameraRef.current.look = "slides"
      cameraRef.current.generation += 1
      stopCameraTracks()
      void stopProgramRecorder()
    }
  }, [applySnapshot, applyProgramLook, startProgramRecorder, stopProgramRecorder, stopCameraTracks, draw, logDebug, pushNdiFrame, pushNdiBurst, pushStreamOverlay])

  // Slow keepalive: push one frame every 2s if idle (prevents NDI receivers from dropping the source)
  useEffect(() => {
    const timer = setInterval(() => {
      if (ndiConfigRef.current.active) {
        const elapsed = Date.now() - lastPushRef.current
        if (elapsed > 2000) void pushNdiFrame()
      }
      if (streamOverlayRef.current) void pushStreamOverlay()
    }, 500)
    return () => clearInterval(timer)
  }, [pushNdiFrame, pushStreamOverlay])

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100vw",
        height: "100vh",
        display: "block",
        objectFit: "contain",
      }}
    />
  )
}

const root = document.getElementById("broadcast-root")!
createRoot(root).render(<BroadcastCanvas />)
