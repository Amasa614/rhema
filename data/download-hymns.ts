/// <reference types="bun-types" />

/**
 * Builds bundled hymn JSON files from Hymnary public-domain data.
 * Methodist list follows UMH numbers from hymnsite.com (titles only; lyrics from Hymnary).
 * Run: bun run download:hymns
 */

import {
  PUBLIC_DATA_DIR,
  buildBundledHymns,
  fetchHymnaryCollection,
  hymnsForTradition,
  writeHymnCollectionFile,
} from "./lib/hymnary-download"
import { buildMethodistUmhHymns, mergeUmhIntoAll } from "./lib/methodist-umh-match"
import { fetchUmhCatalog } from "./lib/umh-hymnsite"

async function main() {
  const [source, umhCatalog] = await Promise.all([
    fetchHymnaryCollection(),
    fetchUmhCatalog(),
  ])

  const baseAll = buildBundledHymns(source)
  const umhReport = buildMethodistUmhHymns(source, umhCatalog)
  const all = mergeUmhIntoAll(baseAll, umhReport.hymns)
  const methodist = umhReport.hymns
  const catholic = hymnsForTradition(all, "catholic")
  const presbyterian = hymnsForTradition(all, "presbyterian")
  const classic = hymnsForTradition(all, "classic")

  await writeHymnCollectionFile(
    `${PUBLIC_DATA_DIR}/hymns-all.json`,
    all,
    "Methodist, Catholic, and Presbyterian (public domain)",
  )
  await writeHymnCollectionFile(
    `${PUBLIC_DATA_DIR}/methodist-hymns.json`,
    methodist,
    "United Methodist Hymnal (UMH) numbers via hymnsite.com; PD texts from Hymnary.org",
  )
  await writeHymnCollectionFile(
    `${PUBLIC_DATA_DIR}/catholic-hymns.json`,
    catholic,
    "Catholic",
  )
  await writeHymnCollectionFile(
    `${PUBLIC_DATA_DIR}/presbyterian-hymns.json`,
    presbyterian,
    "Presbyterian / Reformed",
  )
  await writeHymnCollectionFile(
    `${PUBLIC_DATA_DIR}/classic-hymns.json`,
    classic,
    "Classic / popular",
  )

  console.log(
    `\nTotals: ${all.length} unique hymns (${methodist.length} UMH Methodist matched, ${catholic.length} Catholic, ${presbyterian.length} Presbyterian, ${classic.length} classic).`,
  )
  if (umhReport.unmatched.length > 0) {
    console.log(
      `\n${umhReport.unmatched.length} UMH titles had no public-domain match on Hymnary (copyright or missing text):`,
    )
    for (const entry of umhReport.unmatched.slice(0, 25)) {
      console.log(`  ${entry.number} ${entry.title}`)
    }
    if (umhReport.unmatched.length > 25) {
      console.log(`  … and ${umhReport.unmatched.length - 25} more`)
    }
  }
  console.log(
    "\nNote: Not the official Ghana MHB; UMH numbering from hymnsite.com with PD English texts from Hymnary.org.",
  )
}

await main()
