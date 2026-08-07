import { beforeEach, describe, expect, it, vi } from "vitest"

const invokeMock = vi.fn()

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

describe("broadcast store sync", () => {
  beforeEach(async () => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(1)
    vi.resetModules()
  })

  it("syncBroadcastOutput emits current theme and verse to broadcast window", async () => {
    const { useBroadcastStore } = await import("./broadcast-store")
    const theme = useBroadcastStore.getState().themes[0]
    useBroadcastStore.setState({
      activeThemeId: theme.id,
      liveVerse: {
      reference: "John 3:16",
        segments: [{ text: "For God so loved the world", verseNumber: 16 }],
      },
    })

    invokeMock.mockClear()
    useBroadcastStore.getState().syncBroadcastOutput()

    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(invokeMock).toHaveBeenCalledWith(
      "set_broadcast_snapshot",
      expect.objectContaining({
        outputId: "main",
        payload: expect.objectContaining({
          theme: expect.objectContaining({ id: theme.id }),
          verse: expect.objectContaining({ reference: "John 3:16" }),
        }),
      }),
    )
    expect(invokeMock).toHaveBeenCalledWith(
      "set_broadcast_snapshot",
      expect.objectContaining({ outputId: "alt" }),
    )
  })

  it("setLiveVerse immediately sends the newly selected verse", async () => {
    const { useBroadcastStore } = await import("./broadcast-store")
    invokeMock.mockClear()

    useBroadcastStore.getState().setLiveVerse({
      reference: "Genesis 1:2",
      segments: [{ text: "The earth was without form", verseNumber: 2 }],
    })

    expect(invokeMock).toHaveBeenCalledWith(
      "set_broadcast_snapshot",
      expect.objectContaining({
        outputId: "main",
        payload: expect.objectContaining({
          verse: expect.objectContaining({ reference: "Genesis 1:2" }),
        }),
      }),
    )
  })

  it("syncBroadcastOutputFor does not update the other projector", async () => {
    const { useBroadcastStore } = await import("./broadcast-store")
    invokeMock.mockClear()

    useBroadcastStore.getState().syncBroadcastOutputFor("main")

    expect(invokeMock).toHaveBeenCalledTimes(1)
  })
})
