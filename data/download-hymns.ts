/// <reference types="bun-types" />

/**
 * Builds bundled hymn JSON files from Hymnary public-domain data.
 * Run: bun run download:hymns
 */

import {
  PUBLIC_DATA_DIR,
  buildBundledHymns,
  fetchHymnaryCollection,
  hymnsForTradition,
  writeHymnCollectionFile,
} from "./lib/hymnary-download"

async function main() {
  const source = await fetchHymnaryCollection()
  const all = buildBundledHymns(source)
  const methodist = hymnsForTradition(all, "methodist")
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
    "Methodist / Wesleyan",
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
    `\nTotals: ${all.length} unique hymns (${methodist.length} Methodist, ${catholic.length} Catholic, ${presbyterian.length} Presbyterian, ${classic.length} classic).`,
  )
  console.log(
    "Note: This is not the official Ghana Methodist Hymn Book (MHB); it is public-domain English texts from Hymnary.org.",
  )
}

await main()
