/** Canonical chapter counts per book (book_number 1–66). */
const MAX_CHAPTERS: readonly number[] = [
  0,
  50, 40, 27, 36, 34, 24, 21, 4, 31, 24, 22, 25, 29, 36, 10, 13, 10, 42, 150,
  31, 12, 8, 66, 52, 5, 48, 12, 14, 3, 9, 1, 4, 7, 3, 3, 3, 2, 14, 4,
  28, 16, 24, 21, 28, 16, 16, 13, 6, 6, 4, 4, 5, 3, 6, 4, 3, 1, 13, 5, 5,
  3, 5, 1, 1, 1, 22,
]

export function getMaxChapter(bookNumber: number): number {
  if (bookNumber < 1 || bookNumber > 66) return 1
  return MAX_CHAPTERS[bookNumber] ?? 1
}

export function clampChapter(bookNumber: number, chapter: number): number {
  const max = getMaxChapter(bookNumber)
  return Math.min(Math.max(1, chapter), max)
}
