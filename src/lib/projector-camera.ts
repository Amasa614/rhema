export interface CoverDrawRect {
  x: number
  y: number
  width: number
  height: number
}

export interface MediaDeviceLike {
  deviceId: string
  kind: string
  label: string
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

/** Pick the getUserMedia device whose label best matches a DirectShow camera name. */
export function matchVideoDeviceId(
  devices: MediaDeviceLike[],
  hint: string,
): string | undefined {
  const videos = devices.filter((device) => device.kind === "videoinput")
  if (videos.length === 0) return undefined

  const normalizedHint = normalizeLabel(hint)
  if (!normalizedHint) {
    return videos.find((device) => /iriun|camo/i.test(device.label))?.deviceId
      ?? videos[0]?.deviceId
  }

  const exact = videos.find(
    (device) => normalizeLabel(device.label) === normalizedHint,
  )
  if (exact) return exact.deviceId

  const contained = videos.find((device) => {
    const label = normalizeLabel(device.label)
    return label.includes(normalizedHint) || normalizedHint.includes(label)
  })
  if (contained) return contained.deviceId

  return videos.find((device) => /iriun|camo/i.test(device.label))?.deviceId
}

/** Prefer the phone virtual-cam microphone when the video hint is Camo/Iriun. */
export function matchAudioDeviceId(
  devices: MediaDeviceLike[],
  hint: string,
): string | undefined {
  const audios = devices.filter((device) => device.kind === "audioinput")
  if (audios.length === 0) return undefined
  const phone = audios.find((device) => /iriun|camo/i.test(device.label))
  if (phone && (/iriun|camo/i.test(hint) || !hint.trim())) {
    return phone.deviceId
  }
  const normalizedHint = normalizeLabel(hint)
  if (normalizedHint) {
    const exact = audios.find(
      (device) => normalizeLabel(device.label) === normalizedHint,
    )
    if (exact) return exact.deviceId
    const contained = audios.find((device) => {
      const label = normalizeLabel(device.label)
      return label.includes(normalizedHint) || normalizedHint.includes(label)
    })
    if (contained) return contained.deviceId
  }
  return phone?.deviceId ?? audios[0]?.deviceId
}

export function coverDrawRect(
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
): CoverDrawRect | null {
  if (srcW <= 0 || srcH <= 0 || destW <= 0 || destH <= 0) return null
  const scale = Math.max(destW / srcW, destH / srcH)
  const width = srcW * scale
  const height = srcH * scale
  return {
    x: (destW - width) / 2,
    y: (destH - height) / 2,
    width,
    height,
  }
}

export function drawVideoCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  destW: number,
  destH: number,
  destX = 0,
  destY = 0,
): void {
  const rect = coverDrawRect(video.videoWidth, video.videoHeight, destW, destH)
  if (!rect) {
    ctx.fillStyle = "#000"
    ctx.fillRect(destX, destY, destW, destH)
    return
  }
  ctx.drawImage(
    video,
    destX + rect.x,
    destY + rect.y,
    rect.width,
    rect.height,
  )
}

function videoConstraints(deviceId?: string): MediaTrackConstraints {
  const video: MediaTrackConstraints = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  }
  if (deviceId) video.deviceId = { exact: deviceId }
  return video
}

function audioConstraints(deviceId?: string): MediaTrackConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  }
  if (deviceId) audio.deviceId = { exact: deviceId }
  return audio
}

/** Microphone for the saved video. Separate from the muted projector playback. */
export async function getRecordAudioStream(
  videoHint: string,
): Promise<MediaStream | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null
  const devices = await navigator.mediaDevices.enumerateDevices()
  const preferred = matchAudioDeviceId(devices, videoHint)
  const attempts: Array<MediaTrackConstraints | true> = []
  if (preferred) attempts.push(audioConstraints(preferred))
  attempts.push(audioConstraints())
  attempts.push(true)
  for (const audio of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: false })
    } catch {
      // Transcription may already hold this device; try the next source.
    }
  }
  return null
}

export async function getCameraStream(deviceLabel: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access is not available in this window")
  }

  const devices = await navigator.mediaDevices.enumerateDevices()
  let videoId = matchVideoDeviceId(devices, deviceLabel)
  if (!videoId) {
    const probe = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints(),
      audio: false,
    })
    const labeled = await navigator.mediaDevices.enumerateDevices()
    videoId = matchVideoDeviceId(labeled, deviceLabel)
    probe.getTracks().forEach((track) => track.stop())
  }

  const videoStream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints(videoId),
    audio: false,
  })
  const combined = new MediaStream(videoStream.getVideoTracks())
  const audioStream = await getRecordAudioStream(deviceLabel)
  if (audioStream) {
    for (const track of audioStream.getAudioTracks()) {
      combined.addTrack(track)
    }
  }
  return combined
}

export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return ""
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ]
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ""
}

export function mixCanvasAndAudio(
  canvas: HTMLCanvasElement,
  cameraStream: MediaStream | null,
  fps = 30,
): MediaStream {
  const canvasStream = canvas.captureStream(fps)
  const mixed = new MediaStream(canvasStream.getVideoTracks())
  if (!cameraStream) return mixed
  for (const track of cameraStream.getAudioTracks()) {
    if (track.readyState === "live" && track.enabled) {
      mixed.addTrack(track.clone())
    }
  }
  return mixed
}

export function streamHasLiveAudio(stream: MediaStream | null): boolean {
  return Boolean(
    stream
      ?.getAudioTracks()
      .some((track) => track.readyState === "live" && track.enabled),
  )
}
