import { describe, expect, it } from "vitest"
import { coverDrawRect, matchAudioDeviceId, matchVideoDeviceId } from "./projector-camera"

describe("matchVideoDeviceId", () => {
  const devices = [
    { deviceId: "usb", kind: "videoinput", label: "HD Webcam" },
    { deviceId: "phone", kind: "videoinput", label: "Iriun Webcam" },
    { deviceId: "mic", kind: "audioinput", label: "Iriun Webcam" },
  ]

  it("matches a DirectShow Iriun name to the web camera", () => {
    expect(matchVideoDeviceId(devices, "Iriun Webcam")).toBe("phone")
  })

  it("falls back to a phone virtual cam when the hint is empty", () => {
    expect(matchVideoDeviceId(devices, "")).toBe("phone")
  })

  it("matches a partial dshow label inside a longer web label", () => {
    expect(
      matchVideoDeviceId(
        [
          {
            deviceId: "camo",
            kind: "videoinput",
            label: "Camo Camera (Reincubate)",
          },
        ],
        "Camo Camera",
      ),
    ).toBe("camo")
  })
})

describe("matchAudioDeviceId", () => {
  it("picks the Iriun microphone for an Iriun camera", () => {
    expect(
      matchAudioDeviceId(
        [
          { deviceId: "laptop", kind: "audioinput", label: "Microphone Array" },
          {
            deviceId: "phone",
            kind: "audioinput",
            label: "Microphone (Iriun Webcam)",
          },
        ],
        "Iriun Webcam",
      ),
    ).toBe("phone")
  })

  it("falls back to the first microphone when there is no phone mic", () => {
    expect(
      matchAudioDeviceId(
        [
          { deviceId: "usb", kind: "videoinput", label: "HD Webcam" },
          { deviceId: "array", kind: "audioinput", label: "Microphone Array" },
        ],
        "HD Webcam",
      ),
    ).toBe("array")
  })
})

describe("coverDrawRect", () => {
  it("covers a 16:9 canvas from a taller phone frame", () => {
    const rect = coverDrawRect(1080, 1920, 1920, 1080)
    expect(rect).not.toBeNull()
    expect(rect!.width).toBeGreaterThanOrEqual(1920)
    expect(rect!.height).toBeGreaterThanOrEqual(1080)
  })

  it("returns null when the source has no size yet", () => {
    expect(coverDrawRect(0, 1080, 1920, 1080)).toBeNull()
  })
})
