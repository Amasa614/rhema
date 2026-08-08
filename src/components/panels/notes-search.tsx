import { useDeferredValue, useEffect, useMemo, useState } from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  StickyNoteIcon,
  Trash2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { noteSlides, useNotesStore } from "@/stores/notes-store"

export function NotesSearch({ query }: { query: string }) {
  const notes = useNotesStore((state) => state.notes)
  const isLoading = useNotesStore((state) => state.isLoading)
  const error = useNotesStore((state) => state.error)
  const selectedNote = useNotesStore((state) => state.selectedNote)
  const selectedSlideIndex = useNotesStore((state) => state.selectedSlideIndex)
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())

  const [isCreating, setIsCreating] = useState(false)
  const [draftTitle, setDraftTitle] = useState("")
  const [draftBody, setDraftBody] = useState("")
  const [editTitle, setEditTitle] = useState("")
  const [editBody, setEditBody] = useState("")

  useEffect(() => {
    void useNotesStore.getState().loadNotes()
  }, [])

  useEffect(() => {
    if (!selectedNote) {
      setEditTitle("")
      setEditBody("")
      return
    }
    setEditTitle(selectedNote.title)
    setEditBody(selectedNote.body)
  }, [selectedNote?.id, selectedNote?.title, selectedNote?.body])

  const filteredNotes = useMemo(() => {
    if (!deferredQuery) return notes
    return notes.filter((note) => {
      const blob = `${note.title}\n${note.body}`.toLowerCase()
      return deferredQuery.split(/\s+/).every((word) => blob.includes(word))
    })
  }, [notes, deferredQuery])

  const slides = selectedNote ? noteSlides(selectedNote.body) : []

  const handleCreate = async () => {
    const note = await useNotesStore.getState().addNote({
      title: draftTitle,
      body: draftBody,
    })
    setDraftTitle("")
    setDraftBody("")
    setIsCreating(false)
    useNotesStore.getState().selectNote(note)
  }

  const handleSaveEdit = async () => {
    if (!selectedNote) return
    await useNotesStore.getState().updateNote(selectedNote.id, {
      title: editTitle,
      body: editBody,
    })
  }

  if (isLoading) {
    return <p className="p-6 text-center text-xs text-muted-foreground">Loading notes…</p>
  }

  if (error) {
    return <p className="p-6 text-center text-xs text-destructive">{error}</p>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-[0.625rem] text-muted-foreground tabular-nums">
          {notes.length} note{notes.length === 1 ? "" : "s"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => setIsCreating((value) => !value)}
        >
          <PlusIcon className="size-3" />
          New note
        </Button>
      </div>

      {isCreating ? (
        <div className="shrink-0 space-y-2 border-b border-border p-3">
          <Input
            placeholder="Title (e.g. Announcements)"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            className="h-8 text-xs"
          />
          <Textarea
            placeholder="Note text. Separate slides with a blank line."
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            className="min-h-24 text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setIsCreating(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={!draftBody.trim() && !draftTitle.trim()}
              onClick={() => void handleCreate()}
            >
              Save
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(200px,2fr)_minmax(260px,3fr)]">
        <div className="min-h-0 overflow-y-auto border-r border-border">
          <div className="flex flex-col gap-0 p-2">
            {filteredNotes.map((note) => (
              <button
                key={note.id}
                type="button"
                onClick={() => useNotesStore.getState().selectNote(note)}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-lg border p-3 text-left transition-colors",
                  selectedNote?.id === note.id
                    ? "border-lime-500/50 bg-lime-500/10"
                    : "border-transparent hover:bg-muted/50",
                )}
              >
                <span className="truncate text-sm font-medium">{note.title}</span>
                <span className="line-clamp-2 whitespace-pre-line text-[0.65rem] text-muted-foreground">
                  {note.body}
                </span>
              </button>
            ))}
            {filteredNotes.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">No notes yet</p>
            ) : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-col">
          {selectedNote ? (
            <>
              <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => void handleSaveEdit()}
                  className="h-8 flex-1 border-none bg-transparent text-sm font-semibold shadow-none focus-visible:ring-0"
                />
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={selectedSlideIndex === 0}
                    onClick={() => useNotesStore.getState().selectSlide(selectedSlideIndex - 1)}
                    aria-label="Previous slide"
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <span className="min-w-12 text-center text-[0.65rem] text-muted-foreground">
                    {slides.length > 0 ? selectedSlideIndex + 1 : 0} / {slides.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={selectedSlideIndex >= slides.length - 1}
                    onClick={() => useNotesStore.getState().selectSlide(selectedSlideIndex + 1)}
                    aria-label="Next slide"
                  >
                    <ChevronRightIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-destructive hover:text-destructive"
                    aria-label="Delete note"
                    onClick={() => void useNotesStore.getState().deleteNote(selectedNote.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <Textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  onBlur={() => void handleSaveEdit()}
                  className="min-h-full resize-none border-none bg-transparent text-sm leading-relaxed shadow-none focus-visible:ring-0"
                  placeholder="Type your note. Use a blank line between slides."
                />
                {slides.length > 1 ? (
                  <div className="mt-2 space-y-1 border-t border-border pt-2">
                    <p className="text-[0.625rem] font-medium text-muted-foreground">Slides</p>
                    {slides.map((slide, index) => (
                      <button
                        key={`${selectedNote.id}-slide-${index}`}
                        type="button"
                        onClick={() => useNotesStore.getState().selectSlide(index)}
                        className={cn(
                          "flex w-full gap-2 rounded-lg border p-2 text-left text-xs transition-colors",
                          selectedSlideIndex === index
                            ? "border-lime-500/50 bg-lime-500/10"
                            : "border-transparent hover:bg-muted/50",
                        )}
                      >
                        <span className="w-4 shrink-0 text-right font-semibold text-primary">
                          {index + 1}
                        </span>
                        <span className="line-clamp-3 whitespace-pre-line text-muted-foreground">
                          {slide}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <StickyNoteIcon className="size-6" />
              <p className="text-xs">Select or create a note to show on preview and live</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
