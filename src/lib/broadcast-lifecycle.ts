import { emitTo, listen } from "@tauri-apps/api/event"
import { resolveProgramLook } from "@/lib/program-look"
import { useBroadcastStore } from "@/stores/broadcast-store"
import { useSettingsStore } from "@/stores/settings-store"
import type { ProgramLookPayload } from "@/types/stream"

const readyOutputs = new Set<string>()

function syncProgramLook(outputId: string): void {
  if (outputId !== "main") return
  const settings = useSettingsStore.getState()
  const payload: ProgramLookPayload = {
    look: resolveProgramLook(
      settings.streamProgramLook,
      settings.streamShowOnProjector,
    ),
    deviceLabel: settings.streamVideoDevice,
  }
  void emitTo("broadcast", "broadcast:program-look", payload)
}

/** Keep projector windows in sync even when the Broadcast dialog is closed. */
export function initBroadcastLifecycle(): void {
  void listen<{ outputId: string }>("broadcast:output-ready", (event) => {
    const outputId = event.payload.outputId
    readyOutputs.add(outputId)
    useBroadcastStore.getState().syncBroadcastOutputFor(outputId)
    syncProgramLook(outputId)
    globalThis.setTimeout(() => {
      useBroadcastStore.getState().syncBroadcastOutputFor(outputId)
      syncProgramLook(outputId)
    }, 150)
  })
}

export function isBroadcastOutputReady(outputId: string): boolean {
  return readyOutputs.has(outputId)
}

export async function waitForBroadcastOutputReady(
  outputId: string,
  timeoutMs = 4000,
): Promise<void> {
  if (isBroadcastOutputReady(outputId)) return

  await new Promise<void>((resolve, reject) => {
    let done = false
    let unlisten: (() => void) | null = null

    const cleanup = () => {
      if (unlisten) unlisten()
    }

    const timer = globalThis.setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      reject(new Error("Projector output did not become ready in time."))
    }, timeoutMs)

    void listen<{ outputId: string }>("broadcast:output-ready", (event) => {
      if (done) return
      if (event.payload.outputId !== outputId) return
      done = true
      readyOutputs.add(outputId)
      clearTimeout(timer)
      cleanup()
      resolve()
    }).then((fn) => {
      if (done) fn()
      else unlisten = fn
    })
  })
}
