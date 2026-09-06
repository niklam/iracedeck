// packages/website/src/routeData.ts
// Starlight route-data middleware (0.41+): injects component-rendered
// headings into the page's right-side "On this page" nav, which Starlight
// otherwise builds from MDX headings only. Two consumers:
//   - the icon gallery's class/family headings (issue: gallery feedback
//     wave, item 3);
//   - the three voice-pack reference pages (issue #1066), whose every
//     heading comes from the generated artifact rather than from the MDX.
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

import entries from "./data/icon-gallery.json";
import packReference from "./data/pack-reference.json";
import type { GalleryEntry } from "./gallery-gen/lib.js";
import { buildGalleryToc } from "./gallery-gen/sections.js";
import { parseCallouts, parseRecordingScript } from "./pack-reference-types.js";
import { calloutsToc, recordingScriptToc, type TocItem, vocabularyToc } from "./pack-reference-view.js";

/** Route id → the TOC entries its component renders, built lazily so an unrelated page pays nothing. */
const INJECTED_TOC: ReadonlyMap<string, () => TocItem[]> = new Map([
  ["docs/development/icon-gallery", () => buildGalleryToc(entries as GalleryEntry[])],
  ["docs/voice-packs/reference/callouts", () => calloutsToc(parseCallouts(packReference.callouts))],
  ["docs/voice-packs/reference/vocabulary", () => vocabularyToc()],
  [
    "docs/voice-packs/reference/recording-script",
    () => recordingScriptToc(parseRecordingScript(packReference.recordingScript)),
  ],
]);

export const onRequest = defineRouteMiddleware(({ locals }) => {
  const route = locals.starlightRoute;
  const build = INJECTED_TOC.get(route.id);

  if (build === undefined) return;

  if (!route.toc) return;

  route.toc.items = [...route.toc.items, ...build()];
});
