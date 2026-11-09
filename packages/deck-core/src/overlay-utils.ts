/**
 * SVG data-URI helpers, re-exported from `@iracedeck/icon-composer` so the
 * names actions import through `@iracedeck/deck-core` keep their import path.
 *
 * The inactive overlay that lived here (a filter-based grey with an "N/A"
 * title, off since January 2026) was deleted in #1599, replaced by the
 * disconnected look `BaseAction` composes through `applyDisconnectedLook`;
 * `hexToGrayscale` moved to `@iracedeck/icon-composer`, its one import path.
 */
export { dataUriToSvg, isDataUri, isRawSvg, svgToDataUri } from "@iracedeck/icon-composer";
