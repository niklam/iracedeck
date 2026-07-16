// packages/website/src/routeData.ts
// Starlight route-data middleware (0.41+): injects the icon-gallery's
// component-rendered class/family headings into the page's right-side "On
// this page" nav, which Starlight otherwise builds from MDX headings only
// (issue: gallery feedback wave, item 3).
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

import entries from "./data/icon-gallery.json";
import type { GalleryEntry } from "./gallery-gen/lib.js";
import { buildGalleryToc } from "./gallery-gen/sections.js";

export const onRequest = defineRouteMiddleware(({ locals }) => {
  const route = locals.starlightRoute;

  if (route.id !== "docs/development/icon-gallery") return;

  if (!route.toc) return;

  route.toc.items = [...route.toc.items, ...buildGalleryToc(entries as GalleryEntry[])];
});
