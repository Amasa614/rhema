import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const listenMock = vi.fn()
const syncBroadcastOutputForMock = vi.fn()

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
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
    syncBroadcastOutputForMock.mockReset()
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
})
