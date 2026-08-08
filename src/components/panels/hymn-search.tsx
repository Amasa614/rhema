import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { ChevronLeftIcon, ChevronRightIcon, Music2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { filterAndRankHymns } from "@/lib/hymn-search-rank"
import { hymnDisplayTitle } from "@/lib/hymn-display"
import { useHymnStore } from "@/stores/hymn-store"
import { useNotesStore } from "@/stores/notes-store"
import type { HymnTradition } from "@/types/hymn"

const BROWSE_LIMIT = 200
const SEARCH_LIMIT = 400

type TraditionFilter = "all" | HymnTradition

const TRADITION_LABEL: Record<HymnTradition, string> = {
  methodist: "Methodist",
  catholic: "Catholic",
  presbyterian: "Presbyterian",
  classic: "Classic",
  custom: "My songs",
}

export function HymnSearch({ query }: { query: string }) {
  const hymns = useHymnStore((state) => state.hymns)
  const attribution = useHymnStore((state) => state.attribution)
  const isLoading = useHymnStore((state) => state.isLoading)
  const error = useHymnStore((state) => state.error)
  const selectedHymn = useHymnStore((state) => state.selectedHymn)
  const selectedStanzaIndex = useHymnStore((state) => state.selectedStanzaIndex)
  const [traditionFilter, setTraditionFilter] = useState<TraditionFilter>("all")
  const deferredQuery = useDeferredValue(query.trim())

  useEffect(() => {
    void useHymnStore.getState().loadHymns()
  }, [])

  const filteredByTradition = useMemo(() => {
    if (traditionFilter === "all") return hymns
    return hymns.filter((hymn) => hymn.traditions.includes(traditionFilter))
  }, [hymns, traditionFilter])

  const { results, truncated } = useMemo(() => {
    const limit = deferredQuery ? SEARCH_LIMIT : BROWSE_LIMIT
    const ranked = filterAndRankHymns(filteredByTradition, deferredQuery, limit)
    const totalMatches = deferredQuery
      ? filterAndRankHymns(filteredByTradition, deferredQuery, 10_000).length
      : filteredByTradition.length
    return {
      results: ranked,
      truncated: totalMatches > ranked.length,
    }
  }, [deferredQuery, filteredByTradition])

  if (isLoading) {
    return <p className="p-6 text-center text-xs text-muted-foreground">Loading hymns…</p>
  }

  if (error) {
    return <p className="p-6 text-center text-xs text-destructive">{error}</p>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <Select
          value={traditionFilter}
          onValueChange={(value) => setTraditionFilter(value as TraditionFilter)}
        >
          <SelectTrigger size="sm" className="h-7 w-[200px] text-xs">
            <SelectValue placeholder="All traditions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All traditions</SelectItem>
            <SelectItem value="classic">Classic / popular</SelectItem>
            <SelectItem value="methodist">Methodist / Wesleyan</SelectItem>
            <SelectItem value="catholic">Catholic</SelectItem>
            <SelectItem value="presbyterian">Presbyterian / Reformed</SelectItem>
            <SelectItem value="custom">My songs</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-[0.625rem] text-muted-foreground tabular-nums">
          {filteredByTradition.length.toLocaleString()} hymns
        </span>
      </div>

      {!deferredQuery ? (
        <p className="shrink-0 border-b border-border px-3 py-1.5 text-[0.625rem] text-muted-foreground">
          Type a title in the search bar above (e.g. “abide with me”). Browse shows the first{" "}
          {BROWSE_LIMIT} only.
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,2fr)_minmax(260px,3fr)]">
        <div className="min-h-0 overflow-y-auto border-r border-border">
          <div className="flex flex-col gap-0 p-2">
            {results.map((hymn) => (
              <button
                key={hymn.id}
                type="button"
                onClick={() => {
                  useNotesStore.getState().clearSelection()
                  useHymnStore.getState().selectHymn(hymn)
                }}
                className={cn(
                  "hymn-list-item flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  selectedHymn?.id === hymn.id
                    ? "border-lime-500/50 bg-lime-500/10"
                    : "border-transparent hover:bg-muted/50",
                )}
              >
                <span className="w-8 shrink-0 text-right text-xs font-semibold text-primary">
                  {hymn.number}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                  {hymnDisplayTitle(hymn)}
                </span>
                {hymn.alsoKnownAs?.[0] && hymn.alsoKnownAs[0] !== hymn.title ? (
                  <span className="block truncate text-[0.6rem] text-muted-foreground">
                    Hymnary: {hymn.title}
                  </span>
                ) : null}
                  <span className="flex flex-wrap gap-1 pt-0.5">
                    {hymn.traditions.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-muted px-1 py-0 text-[0.55rem] text-muted-foreground"
                      >
                        {TRADITION_LABEL[t]}
                      </span>
                    ))}
                  </span>
                  {hymn.author ? (
                    <span className="block truncate text-[0.65rem] text-muted-foreground">
                      {hymn.author}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
            {results.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">No hymns found</p>
            ) : null}
            {truncated ? (
              <p className="p-2 text-center text-[0.625rem] text-muted-foreground">
                More matches exist — narrow your search.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-col">
          {selectedHymn ? (
            <>
              <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">
                    {selectedHymn.number}. {hymnDisplayTitle(selectedHymn)}
                  </h3>
                  <p className="truncate text-[0.65rem] text-muted-foreground">
                    {selectedHymn.author ?? "Unknown author"}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={selectedStanzaIndex === 0}
                    onClick={() => useHymnStore.getState().selectStanza(selectedStanzaIndex - 1)}
                    aria-label="Previous stanza"
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <span className="min-w-12 text-center text-[0.65rem] text-muted-foreground">
                    {selectedStanzaIndex + 1} / {selectedHymn.stanzas.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={selectedStanzaIndex >= selectedHymn.stanzas.length - 1}
                    onClick={() => useHymnStore.getState().selectStanza(selectedStanzaIndex + 1)}
                    aria-label="Next stanza"
                  >
                    <ChevronRightIcon />
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {selectedHymn.stanzas.map((stanza, index) => (
                  <button
                    key={`${selectedHymn.id}-${index}`}
                    type="button"
                    onClick={() => useHymnStore.getState().selectStanza(index)}
                    className={cn(
                      "mb-1 flex w-full gap-3 rounded-lg border p-3 text-left transition-colors",
                      selectedStanzaIndex === index
                        ? "border-lime-500/50 bg-lime-500/10"
                        : "border-transparent hover:bg-muted/50",
                    )}
                  >
                    <span className="w-5 shrink-0 text-right text-xs font-semibold text-primary">
                      {index + 1}
                    </span>
                    <span className="whitespace-pre-line text-sm leading-relaxed text-foreground/85">
                      {stanza}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Music2Icon className="size-6" />
              <p className="text-xs">Choose a hymn, then select a stanza to project</p>
            </div>
          )}
          {attribution ? (
            <p className="shrink-0 border-t border-border px-3 py-1 text-[0.55rem] text-muted-foreground">
              Public-domain texts (not the official Ghana MHB). Source:{" "}
              <a className="underline" href="https://hymnary.org" target="_blank" rel="noreferrer">
                Hymnary.org
              </a>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
