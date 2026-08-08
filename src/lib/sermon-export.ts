import { save } from "@tauri-apps/plugin-dialog"
import { writeTextFile } from "@tauri-apps/plugin-fs"
import type { SermonSession } from "@/types/postproduction"

function safeFilename(title: string): string {
  const printable = Array.from(title)
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
  return (
    printable
      .replace(/[<>:"/\\|?*]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "sermon-notes"
  )
}

export async function downloadSermonMarkdown(
  session: SermonSession,
  summary: string
): Promise<boolean> {
  const path = await save({
    defaultPath: `${safeFilename(session.title)}.md`,
    filters: [{ name: "Markdown sermon notes", extensions: ["md"] }],
  })
  if (!path) return false

  const direct = session.scriptures
    .filter((scripture) => scripture.source === "ai-direct")
    .map((scripture) => `- ${scripture.reference}`)
  const queued = session.scriptures
    .filter((scripture) => scripture.source === "queued")
    .map((scripture) => `- ${scripture.reference}`)
  const sections = [
    `# ${session.title}`,
    summary.trim(),
    direct.length > 0
      ? `## Direct AI Scripture Hits\n\n${direct.join("\n")}`
      : "",
    queued.length > 0
      ? `## Queued / Manually Added Scriptures\n\n${queued.join("\n")}`
      : "",
    session.transcript.trim()
      ? `## Transcript\n\n${session.transcript.trim()}`
      : "",
  ].filter(Boolean)

  await writeTextFile(path, `${sections.join("\n\n")}\n`)
  return true
}
