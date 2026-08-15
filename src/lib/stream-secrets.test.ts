import { describe, expect, it } from "vitest"
import { redactRtmpSecrets } from "./stream-secrets"

describe("redactRtmpSecrets", () => {
  it("redacts rtmp and rtmps destinations", () => {
    const input =
      "Could not start live stream: Failed to open rtmps://a.rtmps.youtube.com/live2/abc-key-123"
    const cleaned = redactRtmpSecrets(input, "abc-key-123")
    expect(cleaned).not.toContain("abc-key-123")
    expect(cleaned.toLowerCase()).not.toContain("rtmps://")
    expect(cleaned).toContain("[rtmp destination]")
  })

  it("redacts a bare stream key outside a url", () => {
    const cleaned = redactRtmpSecrets("Server returned 403 for xyz-secret", "xyz-secret")
    expect(cleaned).not.toContain("xyz-secret")
    expect(cleaned).toContain("[stream key]")
  })

  it("leaves unrelated errors unchanged", () => {
    const message = "FFmpeg not found. Install FFmpeg and add it to PATH."
    expect(redactRtmpSecrets(message)).toBe(message)
  })
})
