import { listen } from "@tauri-apps/api/event"
import { useBroadcastStore } from "@/stores/broadcast-store"

/** Keep projector windows in sync even when the Broadcast dialog is closed. */
export function initBroadcastLifecycle(): void {
  void listen<{ outputId: string }>("broadcast:output-ready", (event) => {
    const outputId = event.payload.outputId
    useBroadcastStore.getState().syncBroadcastOutputFor(outputId)
    globalThis.setTimeout(() => {
      useBroadcastStore.getState().syncBroadcastOutputFor(outputId)
    }, 150)
  })
}
