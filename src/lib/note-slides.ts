export interface NoteProjectionSlide {
  heading: string | null
  text: string
}

const MAX_WORDS = 24
const MAX_CHARACTERS = 160

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/([*_~`])(.+?)\1/g, "$2")
    .trim()
}

function countWords(value: string): number {
  return value.split(/\s+/).filter(Boolean).length
}

function splitByLimit(value: string): string[] {
  const words = value.split(/\s+/).filter(Boolean)
  const chunks: string[] = []
  let chunk: string[] = []

  for (const word of words) {
    const candidate = [...chunk, word].join(" ")
    if (
      chunk.length > 0 &&
      (chunk.length >= MAX_WORDS || candidate.length > MAX_CHARACTERS)
    ) {
      chunks.push(chunk.join(" "))
      chunk = [word]
    } else {
      chunk.push(word)
    }
  }
  if (chunk.length > 0) chunks.push(chunk.join(" "))
  return chunks
}

function contentChunks(line: string): string[] {
  const bullet = /^[-*+]\s+/.test(line)
  const cleaned = cleanInlineMarkdown(
    bullet ? line.replace(/^[-*+]\s+/, "") : line
  )
  if (!cleaned) return []

  const sentences = cleaned
    .match(/[^.!?;]+(?:[.!?;]+|$)/g)
    ?.map((part) => part.trim()) ?? [cleaned]
  return sentences.flatMap((sentence) =>
    splitByLimit(bullet ? `• ${sentence}` : sentence)
  )
}

export function buildNoteProjectionSlides(body: string): NoteProjectionSlide[] {
  const slides: NoteProjectionSlide[] = []
  let heading: string | null = null
  let pending: string[] = []

  const flush = () => {
    if (pending.length === 0) return
    slides.push({ heading, text: pending.join("\n") })
    pending = []
  }

  for (const rawLine of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim()
    if (!line) {
      flush()
      continue
    }

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/)
    if (headingMatch) {
      flush()
      heading = cleanInlineMarkdown(headingMatch[1])
      continue
    }

    for (const chunk of contentChunks(line)) {
      const candidate = [...pending, chunk].join(" ")
      if (
        pending.length > 0 &&
        (countWords(candidate) > MAX_WORDS || candidate.length > MAX_CHARACTERS)
      ) {
        flush()
      }
      pending.push(chunk)
    }
  }
  flush()

  if (slides.length > 0) return slides
  return [{ heading: null, text: cleanInlineMarkdown(body) || " " }]
}
