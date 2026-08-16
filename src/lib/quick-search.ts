/**
 * Quick Search Utility Functions
 * Pure functions for Bible reference autocomplete logic
 */

export interface Book {
  id: number
  translation_id: number
  book_number: number
  name: string
  abbreviation: string
  testament: string
}

export interface AutocompleteResult {
  suggestion: string
  matchedBook?: Book
  chapter?: number
  verse?: number
  stage: "book" | "chapter" | "verse" | "complete" | "none"
}

const THIRD_PREFIX = /^(?:3rd|third|iii)(?=[\s.]|$)/i
const SECOND_PREFIX = /^(?:2nd|second|ii)(?=[\s.]|$)/i
const FIRST_PREFIX = /^(?:1st|first|i)(?=[\s.]|$)/i
const DIGIT_PREFIX = /^(\d+)(?:st|nd|rd|th)?(?=[\s.]|$)/i

/**
 * Convert number to Roman numeral for numbered books
 */
export function numberToRoman(num: number): string {
  if (num === 1) return "I"
  if (num === 2) return "II"
  if (num === 3) return "III"
  return String(num)
}

function splitNumberedPrefix(text: string): { num: number | null; rest: string } {
  const trimmed = text.trim()
  const patterns: Array<[RegExp, number | "digit"]> = [
    [THIRD_PREFIX, 3],
    [SECOND_PREFIX, 2],
    [FIRST_PREFIX, 1],
    [DIGIT_PREFIX, "digit"],
  ]

  for (const [pattern, value] of patterns) {
    const match = trimmed.match(pattern)
    if (!match) continue
    const num = value === "digit" ? Number.parseInt(match[1], 10) : value
    const rest = trimmed.slice(match[0].length).replace(/^[\s.]+/, "")
    return { num, rest }
  }

  return { num: null, rest: trimmed }
}

/** Canonical "1 kings" form so 1st/I/1 Kings all compare equal. */
export function canonicalizeBookKey(text: string): string {
  const { num, rest } = splitNumberedPrefix(text)
  const body = rest.toLowerCase().replace(/\s+/g, " ").trim()
  if (num === null) return body
  return body ? `${num} ${body}` : String(num)
}

/**
 * Normalize input: convert leading numbers/ordinals to Roman numerals for matching
 * Examples: "1 S" -> "I S", "1st kings" -> "I kings", "2nd samuel" -> "II samuel"
 */
export function normalizeInput(input: string): string {
  const { num, rest } = splitNumberedPrefix(input)
  if (num === null) return input.trim()
  const roman = numberToRoman(num)
  return rest ? `${roman} ${rest}` : roman
}

/**
 * Find matching book by name or abbreviation (case insensitive)
 */
export function findMatchingBook(bookInput: string, books: Book[]): Book | undefined {
  const needle = canonicalizeBookKey(bookInput)
  if (!needle) return undefined
  return books.find((book) => {
    const name = canonicalizeBookKey(book.name)
    const abbreviation = canonicalizeBookKey(book.abbreviation)
    return name.startsWith(needle) || abbreviation.startsWith(needle)
  })
}

/**
 * Parse Bible reference input and return autocomplete suggestion
 */
export function getAutocompleteSuggestion(
  input: string,
  books: Book[]
): AutocompleteResult {
  const trimmed = input.trim()

  if (!trimmed) {
    return { suggestion: "", stage: "none" }
  }

  const normalizedInput = normalizeInput(trimmed)

  // Check if it's just a number (for numbered books like "1", "2", "3")
  if (/^\d+$/.test(trimmed)) {
    const matchingBook = findMatchingBook(trimmed, books)

    if (matchingBook) {
      return {
        suggestion: matchingBook.name + " 1:1",
        matchedBook: matchingBook,
        chapter: 1,
        verse: 1,
        stage: "book"
      }
    }
  }

  // Parse: "NumberedBook Chapter:Verse" or "BookName Chapter:Verse"
  // Match patterns like: "I J", "I John", "John", "John 3", "John 3:16"
  const match = normalizedInput.match(/^([IVX]+\s+[a-zA-Z]+|[IVX]+\s+[a-zA-Z\s]+|[a-zA-Z\s]+?)\s*(\d+)?:?(\d+)?$/)

  if (!match) {
    return { suggestion: "", stage: "none" }
  }

  const bookInput = match[1].trim()
  const chapterNum = match[2]
  const verseNum = match[3]

  const matchingBook = findMatchingBook(bookInput, books)

  if (!matchingBook) {
    return { suggestion: "", stage: "none" }
  }

  // Stage 1: Autocomplete book name + suggest 1:1
  if (!chapterNum) {
    return {
      suggestion: matchingBook.name + " 1:1",
      matchedBook: matchingBook,
      chapter: 1,
      verse: 1,
      stage: "book"
    }
  }

  const chapter = parseInt(chapterNum)

  // Stage 2: Suggest colon after chapter
  if (!verseNum && !trimmed.includes(':')) {
    return {
      suggestion: trimmed + ":1",
      matchedBook: matchingBook,
      chapter,
      verse: 1,
      stage: "chapter"
    }
  }

  // Stage 3: Has colon but no verse number yet
  if (!verseNum && trimmed.includes(':')) {
    return {
      suggestion: "",
      matchedBook: matchingBook,
      chapter,
      stage: "verse"
    }
  }

  // Stage 4: Complete reference
  if (verseNum) {
    const verse = parseInt(verseNum)
    return {
      suggestion: "",
      matchedBook: matchingBook,
      chapter,
      verse,
      stage: "complete"
    }
  }

  return { suggestion: "", stage: "none" }
}

/**
 * Determine what should happen when Tab/Arrow-Right is pressed
 */
export function getTabNavigationResult(
  currentInput: string,
  currentSuggestion: string
): string {
  if (!currentSuggestion || currentSuggestion === currentInput) {
    return currentInput
  }

  const trimmed = currentInput.trim()
  const suggestionTrimmed = currentSuggestion.trim()

  // Extract the full book name from the suggestion
  const bookNameMatch = suggestionTrimmed.match(/^(([IVX]+\s+)?[a-zA-Z\s]+)\s+\d+:\d+$/)

  if (bookNameMatch) {
    const fullBookName = bookNameMatch[1]

    // Check if current input matches the COMPLETE book name
    const currentIsCompleteBookName =
      trimmed === fullBookName + " " || trimmed === fullBookName

    // Check if current input has a chapter number
    const hasChapter =
      new RegExp(`^${fullBookName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\d+`, 'i').test(trimmed) &&
      !trimmed.includes(':')

    // Stage 1: Still typing book name -> advance to complete book name
    if (!currentIsCompleteBookName && !hasChapter) {
      return fullBookName + " "
    }

    // Stage 2: Has chapter -> advance to chapter with colon
    if (hasChapter) {
      const chapterMatch = suggestionTrimmed.match(/^(([IVX]+\s+)?[a-zA-Z\s]+\s+\d+):\d+$/)
      if (chapterMatch) {
        return chapterMatch[1] + ":"
      }
    }
  }

  // Default: accept full suggestion
  return currentSuggestion
}
