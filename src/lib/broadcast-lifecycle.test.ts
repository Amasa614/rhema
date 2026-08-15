import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ProgramLook } from "@/types/stream"

const listenMock = vi.fn()
const emitToMock = vi.fn()
const syncBroadcastOutputForMock = vi.fn()
const settingsState = {
  streamShowOnProjector: false,
  streamVideoDevice: "",
  streamProgramLook: "slides" as ProgramLook,
}

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
  emitTo: emitToMock,
}))

vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: {
    getState: () => settingsState,
  },
}))

vi.mock("@/stores/broadcast-store", () => ({
  useBroadcastStore: {
    getState: () => ({
      syncBroadcastOutputFor: syncBroadcastOutputForMock,
    }),
  },
}))

describe("broadcast output lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listenMock.mockReset()
    emitToMock.mockReset()
    syncBroadcastOutputForMock.mockReset()
    settingsState.streamShowOnProjector = false
    settingsState.streamVideoDevice = ""
    settingsState.streamProgramLook = "slides"
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("syncs only the output that reports ready", async () => {
    let readyHandler:
      | ((event: { payload: { outputId: string } }) => void)
      | undefined
    listenMock.mockImplementation(
      async (
        _event: string,
        handler: (event: { payload: { outputId: string } }) => void,
      ) => {
        readyHandler = handler
        return vi.fn()
      },
    )

    const { initBroadcastLifecycle } = await import("./broadcast-lifecycle")
    initBroadcastLifecycle()
    readyHandler?.({ payload: { outputId: "main" } })

    expect(syncBroadcastOutputForMock).toHaveBeenCalledWith("main")
  })

  it("retries synchronization after the output becomes ready", async () => {
    let readyHandler:
      | ((event: { payload: { outputId: string } }) => void)
      | undefined
    listenMock.mockImplementation(
      async (
        _event: string,
        handler: (event: { payload: { outputId: string } }) => void,
      ) => {
        readyHandler = handler
        return vi.fn()
      },
    )

    const { initBroadcastLifecycle } = await import("./broadcast-lifecycle")
    initBroadcastLifecycle()
    readyHandler?.({ payload: { outputId: "alt" } })
    vi.advanceTimersByTime(150)

    expect(syncBroadcastOutputForMock).toHaveBeenCalledTimes(2)
  })

  it("starts the projector camera when the main output is ready", async () => {
    settingsState.streamShowOnProjector = true
    settingsState.streamVideoDevice = "Iriun Webcam"
    settingsState.streamProgramLook = "mix"
    let readyHandler:
      | ((event: { payload: { outputId: string } }) => void)
      | undefined
    listenMock.mockImplementation(
      async (
        _event: string,
        handler: (event: { payload: { outputId: string } }) => void,
      ) => {
        readyHandler = handler
        return vi.fn()
      },
    )

    const { initBroadcastLifecycle } = await import("./broadcast-lifecycle")
    initBroadcastLifecycle()
    readyHandler?.({ payload: { outputId: "main" } })

    expect(emitToMock).toHaveBeenCalledWith("broadcast", "broadcast:program-look", {
      look: "mix",
      deviceLabel: "Iriun Webcam",
    })
  })

  it("treats an output as ready after it reports", async () => {
    let readyHandler:
      | ((event: { payload: { outputId: string } }) => void)
      | undefined
    listenMock.mockImplementation(
      async (
        _event: string,
        handler: (event: { payload: { outputId: string } }) => void,
      ) => {
        readyHandler = handler
        return vi.fn()
      },
    )

    const { initBroadcastLifecycle, isBroadcastOutputReady, waitForBroadcastOutputReady } =
      await import("./broadcast-lifecycle")
    initBroadcastLifecycle()
    readyHandler?.({ payload: { outputId: "main" } })

    expect(isBroadcastOutputReady("main")).toBe(true)
    await expect(waitForBroadcastOutputReady("main", 50)).resolves.toBeUndefined()
  })
})
