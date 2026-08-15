import { describe, expect, it } from "vitest"
import {
  programLookFromCameraUnderlay,
  programLookUsesCamera,
  resolveProgramLook,
} from "./program-look"

describe("program look", () => {
  it("keeps a saved look", () => {
    expect(resolveProgramLook("camera", false)).toBe("camera")
    expect(resolveProgramLook("mix", false)).toBe("mix")
    expect(resolveProgramLook("slides", true)).toBe("slides")
  })

  it("derives mix from the old projector-camera switch", () => {
    expect(resolveProgramLook(undefined, true)).toBe("mix")
    expect(resolveProgramLook(undefined, false)).toBe("slides")
  })

  it("uses the camera for camera and mix looks", () => {
    expect(programLookUsesCamera("camera")).toBe(true)
    expect(programLookUsesCamera("mix")).toBe(true)
    expect(programLookUsesCamera("slides")).toBe(false)
  })

  it("maps the old camera-underlay event onto mix or a camera release", () => {
    expect(programLookFromCameraUnderlay(true, "Iriun Webcam")).toEqual({
      look: "mix",
      deviceLabel: "Iriun Webcam",
      releaseCamera: false,
    })
    expect(programLookFromCameraUnderlay(false, "")).toEqual({
      look: "slides",
      deviceLabel: "",
      releaseCamera: true,
    })
  })
})
