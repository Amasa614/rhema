import type { ProgramLook, ProgramLookPayload } from "@/types/stream"

export function resolveProgramLook(
  look: ProgramLook | undefined,
  showOnProjector: boolean,
): ProgramLook {
  if (look === "camera" || look === "slides" || look === "mix") return look
  return showOnProjector ? "mix" : "slides"
}

export function programLookUsesCamera(look: ProgramLook): boolean {
  return look !== "slides"
}

export const PROGRAM_LOOK_LABEL: Record<ProgramLook, string> = {
  camera: "Camera",
  mix: "Mix",
  slides: "Slides",
}

export function programLookFromCameraUnderlay(
  active: boolean,
  deviceLabel?: string,
): ProgramLookPayload {
  return {
    look: active ? "mix" : "slides",
    deviceLabel,
    releaseCamera: !active,
  }
}
