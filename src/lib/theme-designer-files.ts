import { open, save } from "@tauri-apps/plugin-dialog"
import { readFile, writeTextFile } from "@tauri-apps/plugin-fs"
import type { BroadcastTheme } from "@/types"

/**
 * Opens a native file dialog to pick an image, reads it,
 * and returns a base64 data URL that persists across restarts.
 */
export async function pickThemeBackgroundImage(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"],
      },
    ],
  })
  if (!selected) return null

  const path = typeof selected === "string" ? selected : selected
  const bytes = await readFile(path)
  const extension = path.split(".").pop()?.toLowerCase() ?? "png"
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
  }
  const mime = mimeMap[extension] ?? "image/png"

  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  const base64 = btoa(binary)
  return `data:${mime};base64,${base64}`
}

/** Uses the same picker as background (returns a persisted data URL). */
export async function pickThemeLogoImage(): Promise<string | null> {
  return pickThemeBackgroundImage()
}

/**
 * Exports a theme as JSON via native save dialog.
 */
export async function exportTheme(theme: BroadcastTheme): Promise<void> {
  const path = await save({
    defaultPath: `${theme.name.replace(/[^a-zA-Z0-9-_ ]/g, "")}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  })
  if (!path) return

  const json = JSON.stringify(theme, null, 2)
  await writeTextFile(path, json)
}

/**
 * Imports a theme from a JSON file via native open dialog.
 * Returns the parsed theme or null if cancelled/invalid.
 */
export async function importTheme(): Promise<BroadcastTheme | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Theme JSON", extensions: ["json"] }],
  })
  if (!selected) return null

  const path = typeof selected === "string" ? selected : selected
  const bytes = await readFile(path)
  const text = new TextDecoder().decode(bytes)
  let parsed: BroadcastTheme
  try {
    parsed = JSON.parse(text) as BroadcastTheme
  } catch {
    throw new Error(
      "That file is not a theme. Import a .json export from Theme Designer. PNG and JPG images are added under Background or Logo.",
    )
  }

  if (!parsed.id || !parsed.name || !parsed.background || !parsed.layout) {
    throw new Error("Invalid theme file: missing required fields")
  }

  return {
    ...parsed,
    id: crypto.randomUUID(),
    builtin: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}
