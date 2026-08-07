import { createRoot } from "react-dom/client"
import { useRef, useEffect, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"
import { renderVerse } from "@/lib/verse-renderer"
import type { BroadcastTheme, VerseRenderData } from "@/types/broadcast"
import type { NdiConfigEventPayload, NdiFrameRequest } from "@/types"

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

  const logDebug = useCallback((message: string, meta?: unknown) => {
    if (!import.meta.env.DEV) return
    if (meta === undefined) {
      console.debug(`[broadcast-output] ${message}`)
      return
    }
    console.debug(`[broadcast-output] ${message}`, meta)
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const data = latestData.current
    if (!data) {
      // Black screen when no data
      ctx.fillStyle = "#000"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      return
    }

    const { theme, verse } = data
    if (canvas.width !== theme.resolution.width) {
      canvas.width = theme.resolution.width
    }
    if (canvas.height !== theme.resolution.height) {
      canvas.height = theme.resolution.height
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
  }, [logDebug])

  const preloadBackgroundImage = useCallback((theme: BroadcastTheme) => {
    const bg = theme.background
    if (bg.type !== "image" || !bg.image?.url) return

    const url = bg.image.url
    const cache = imageCacheRef.current
    if (cache.has(url)) return

    const img = new Image()
    img.onload = () => {
      cache.set(url, img)
      logDebug("Background image loaded", { url })
      draw()
    }
    img.onerror = () => {
      console.warn("[broadcast-output] failed to load background image", { url })
    }
    img.src = url
  }, [draw, logDebug])

  const applySnapshot = useCallback((snapshot: BroadcastSnapshot) => {
    if (snapshot.version < latestVersion.current) return
    latestVersion.current = snapshot.version
    latestData.current = snapshot.payload
    preloadBackgroundImage(snapshot.payload.theme)
    logDebug("Applied broadcast snapshot", {
      version: snapshot.version,
      hasVerse: Boolean(snapshot.payload.verse),
      themeId: snapshot.payload.theme.id,
    })
    draw()
  }, [draw, logDebug, preloadBackgroundImage])

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
      console.warn("[broadcast-output] push_ndi_frame failed", error)
    } finally {
      pushingRef.current = false
    }
  }, [])

  /** Push a burst of 3 frames after content changes (NDI receivers need a few frames to sync) */
  const pushNdiBurst = useCallback(() => {
    void pushNdiFrame()
    setTimeout(() => void pushNdiFrame(), 150)
    setTimeout(() => void pushNdiFrame(), 300)
  }, [pushNdiFrame])

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
      const [unlistenVerse, unlistenNdiConfig] = await Promise.all([
        currentWindow.listen<BroadcastSnapshot>("broadcast:snapshot-update", (event) => {
          applySnapshot(event.payload)
          pushNdiBurst()
        }),
        currentWindow.listen<NdiConfigEventPayload>("broadcast:ndi-config", (event) => {
          ndiConfigRef.current = event.payload
          logDebug("Received broadcast:ndi-config", event.payload)
          if (event.payload.active) pushNdiBurst()
        }),
      ])

      if (disposed) {
        unlistenVerse()
        unlistenNdiConfig()
        return
      }

      removeListeners = () => {
        unlistenVerse()
        unlistenNdiConfig()
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
    }
  }, [applySnapshot, draw, logDebug, pushNdiFrame, pushNdiBurst])

  // Slow keepalive: push one frame every 2s if idle (prevents NDI receivers from dropping the source)
  useEffect(() => {
    const timer = setInterval(() => {
      if (!ndiConfigRef.current.active) return
      const elapsed = Date.now() - lastPushRef.current
      if (elapsed > 2000) void pushNdiFrame()
    }, 2000)
    return () => clearInterval(timer)
  }, [pushNdiFrame])

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
