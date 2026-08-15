import { listen } from "@tauri-apps/api/event"
import type { ProgramPreviewPayload } from "@/types/stream"

type CameraFrameListener = (jpeg: string | null) => void

const listeners = new Set<CameraFrameListener>()
let listening = false

function ensureListener(): void {
  if (listening) return
  listening = true
  void listen<ProgramPreviewPayload>("broadcast:program-preview", (event) => {
    const jpeg = event.payload.jpeg
    for (const listener of listeners) listener(jpeg)
  })
}

export function subscribeProgramCameraFrame(
  listener: CameraFrameListener,
): () => void {
  ensureListener()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
