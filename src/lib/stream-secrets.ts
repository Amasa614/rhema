export function redactRtmpSecrets(text: string, streamKey?: string): string {
  if (!text) return text

  let out = text

  // Redact any RTMP destination URL that may include the key.
  out = out.replace(/rtmps?:\/\/\S+/gi, "[rtmp destination]")

  const key = streamKey?.trim()
  if (key) {
    // Belt-and-suspenders: if the key appears outside a URL, redact it too.
    out = out.split(key).join("[stream key]")
  }

  return out
}

