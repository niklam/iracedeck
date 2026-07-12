/**
 * Race Admin — Car Selector helpers (issue #732)
 *
 * The `select-car` Race Admin mode turns a Stream Deck key into a "placeholder"
 * car button: it shows the car occupying its slot and on press stores that
 * car's `CarIdx` as the shared admin target (read back by the `selected-car`
 * driver target). These are the pure, side-effect-free pieces (slot math,
 * session→car resolution, icon rendering) so they can be unit-tested without
 * the action lifecycle.
 *
 * Slot assignment (issue #754): a key's slot is its row-major ORDINAL among
 * the select-car keys visible on the same device + page — any number of keys,
 * placed anywhere, no reserved cells — offset by the learned key counts of all
 * earlier pages (`pageStartSlot`). The action learns each page's count as the
 * user visits it (entry always lands on page 0; Stream Deck page nav is ±1,
 * so by the time page N shows, pages 0..N−1 are known). The field is sorted by
 * car number (pace car and spectators excluded). See
 * `.claude/rules/profiles-and-devices.md`.
 */
import {
  escapeXml,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalTitleSettings,
  renderIconTemplate,
  resolveBorderSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import { getAllCarNumbers, splitDriverName } from "@iracedeck/iracing-sdk";

import selectorTemplate from "../../../icons/race-admin-car-selector.svg";
import profilesData from "../data/profiles.json" with { type: "json" };

/**
 * Internal passthrough global-settings key holding the currently selected admin
 * target as a `{ carIdx, carNumber }` record (renamed from
 * `_raceAdminSelectedCar` in #790 — the selector is now a generic pick-a-car
 * surface). Follows the `_`-prefixed convention for shared internal state
 * (like `_warnings` / `_lastSeenVersion`) — no schema field. The car number is
 * stored alongside the CarIdx as a staleness guard: CarIdx assignments are
 * session-scoped while global settings persist across sessions, so a reader
 * must treat the selection as void when the CarIdx no longer resolves to the
 * stored number (see `resolveSelectedCar`). Focus-intent presses never write
 * it — only the admin (no-intent) press does.
 */
export const SELECTED_CAR_KEY = "_selectedCar" as const;

/**
 * Pre-#790 name of {@link SELECTED_CAR_KEY}. Read as a fallback (never
 * written) so an in-flight selection survives a mid-session plugin upgrade.
 */
export const LEGACY_SELECTED_CAR_KEY = "_raceAdminSelectedCar" as const;

/**
 * The profile a select-car press switches to when none is configured, as a
 * DISPLAY name — resolved to the pressing device's manifest name (device
 * suffix appended) at press time (#753).
 */
export const DEFAULT_SELECTOR_TARGET_PROFILE = "iRaceDeck Race Admin Per Car" as const;

/**
 * Bundled profile (manifest) names available for a device type, read from the
 * generated `data/profiles.json` (mirrors the manifest). Same shape as the
 * Switch Profile action's helper of the same name.
 *
 * @internal Exported for testing
 */
export function availableProfilesForDevice(deviceType: number | undefined): string[] {
  if (deviceType === undefined) return [];

  return profilesData.filter((p) => p.deviceType === deviceType).map((p) => p.name);
}

/**
 * The `_deviceProfiles` entries pushed for the Target Profile PI dropdown:
 * each available manifest name paired with its clean display label, so the
 * dropdown never shows device suffixes (#753). Same shape as the Switch
 * Profile action's helper of the same name.
 *
 * @internal Exported for testing
 */
export function deviceProfileEntries(deviceType: number | undefined): { name: string; label: string }[] {
  if (deviceType === undefined) return [];

  return profilesData.filter((p) => p.deviceType === deviceType).map((p) => ({ name: p.name, label: p.displayName }));
}

/** The shared admin target persisted under `SELECTED_CAR_KEY`. */
export interface SelectedCar {
  carIdx: number;
  carNumber: string;
}

/** A car occupying a selector slot: the persisted target plus display fields. */
export interface SlotCar extends SelectedCar {
  /** Driver's last name (empty when the session has no name for the entry). */
  lastName: string;
}

/** What the selector key renders: the car number plus an optional driver name. */
export interface SelectorDisplayCar {
  carNumber: string;
  lastName?: string;
}

/**
 * Parse the raw `SELECTED_CAR_KEY` global-settings value. Returns `null` for
 * anything that isn't a well-formed `{ carIdx, carNumber }` record.
 *
 * @internal Exported for testing
 */
export function parseSelectedCar(raw: unknown): SelectedCar | null {
  if (typeof raw !== "object" || raw === null) return null;

  const { carIdx, carNumber } = raw as Record<string, unknown>;

  if (typeof carIdx !== "number" || carIdx < 0 || typeof carNumber !== "string" || !carNumber) return null;

  return { carIdx, carNumber };
}

/** Grid position of a visible select-car key. */
export interface SelectorKeyPosition {
  column: number;
  row: number;
}

/**
 * Parse the `selectorPage` textfield value (0-based). Anything non-numeric,
 * non-finite, or negative is page `0`.
 *
 * @internal Exported for testing
 */
export function parseSelectorPage(raw: string | undefined): number {
  const n = Number(raw);

  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Row-major ordinal (0-based) of `self` among the select-car keys visible on
 * the same device + page. Any number of keys, placed anywhere, works: cars fill
 * the placed keys left→right, top→bottom, with no reserved cells (issue #754).
 * `keys` may include `self`; only keys strictly before it count.
 *
 * @internal Exported for testing
 */
export function selectorOrdinal(self: SelectorKeyPosition, keys: readonly SelectorKeyPosition[]): number {
  return keys.filter((k) => k.row < self.row || (k.row === self.row && k.column < self.column)).length;
}

/**
 * First field slot of `page`, from the learned per-page key counts: the sum of
 * the counts of all earlier pages. Page 0 always starts at 0. Returns `null`
 * when any earlier page's count is unknown (that page hasn't been visited this
 * run) — the caller renders blank rather than guessing (issue #754).
 *
 * @internal Exported for testing
 */
export function pageStartSlot(page: number, pageCounts: ReadonlyMap<number, number>): number | null {
  let start = 0;

  for (let p = 0; p < page; p++) {
    const count = pageCounts.get(p);

    if (count === undefined || count <= 0) return null;

    start += count;
  }

  return start;
}

/**
 * Resolve the car occupying a given field slot from live session info. The
 * field is the car-number-sorted list (pace car and spectators excluded), so
 * slot `0` is the lowest car number. Returns `null` when the slot is empty
 * (fewer cars than slots) or the index is invalid.
 *
 * @internal Exported for testing
 */
export function resolveSlotCar(sessionInfo: unknown, slotIndex: number | null): SlotCar | null {
  if (slotIndex === null || slotIndex < 0) return null;

  const cars = getAllCarNumbers(sessionInfo, true, true);
  const car = cars[slotIndex];

  if (!car) return null;

  return { carIdx: car.carIdx, carNumber: car.carNumber, lastName: splitDriverName(car.userName).lastName };
}

/**
 * Resolve the shared admin target against the CURRENT session: returns the
 * stored car number only while the stored CarIdx still maps to it. A CarIdx is
 * session-scoped but the selection persists in global settings, so after a
 * session change the same index can belong to a different driver — the number
 * mismatch detects that and voids the selection (`null`).
 *
 * @internal Exported for testing
 */
export function resolveSelectedCar(
  raw: unknown,
  currentNumberForIdx: (carIdx: number) => string | null,
): string | null {
  const selected = parseSelectedCar(raw);

  if (!selected) return null;

  return currentNumberForIdx(selected.carIdx) === selected.carNumber ? selected.carNumber : null;
}

/** Settings subset the selector icon needs (derived to avoid a cycle with the action). */
type SelectorRenderSettings = {
  colorOverrides?: Parameters<typeof resolveIconColors>[2];
  titleOverrides?: Parameters<typeof resolveTitleSettings>[2];
  borderOverrides?: Parameters<typeof resolveBorderSettings>[2];
};

/**
 * Fixed number font size, chosen so a 3-digit number ("888") fits the 144px
 * key with margins. Deliberately NOT scaled per digit count — every key on the
 * selector grid renders its number at the same size.
 */
const NUMBER_FONT_SIZE = 70;

/**
 * Big centered car number at a fixed size, with the driver's last name below.
 * The name shrinks to fit long names (uppercase Arial bold ≈ 0.68em per char
 * into ~130px of usable width) but never below a readable floor.
 */
function carDisplayContent(car: SelectorDisplayCar, textColor: string): string {
  const numberText = `<text x="72" y="78" text-anchor="middle" fill="${textColor}" font-family="Arial, sans-serif" font-size="${NUMBER_FONT_SIZE}" font-weight="bold">${escapeXml(car.carNumber)}</text>`;

  const name = car.lastName?.trim().toUpperCase() ?? "";

  if (!name) return numberText;

  const nameFontSize = Math.max(11, Math.min(22, Math.floor(130 / (0.68 * name.length))));
  const nameText = `<text x="72" y="121" text-anchor="middle" fill="${textColor}" font-family="Arial, sans-serif" font-size="${nameFontSize}" font-weight="bold">${escapeXml(name)}</text>`;

  return `${numberText}\n    ${nameText}`;
}

/**
 * Render the selector key icon: a pure-black button with a big fixed-size car
 * number and the driver's last name below (white-on-black by default,
 * themeable via the standard color / border / title overrides). An empty slot
 * renders as a blank black key.
 *
 * @internal Exported for testing
 */
export function generateSelectorSvg(
  car: SelectorDisplayCar | null,
  settings: SelectorRenderSettings,
  highlighted = false,
): string {
  const colors = resolveIconColors(selectorTemplate, getGlobalColors(), settings.colorOverrides);
  const textColor = colors.textColor;

  // Focused-car highlight (#790): while a focus intent is active, the key
  // whose car the camera is on renders a green ring — the grid doubles as a
  // "who am I watching" display. Drawn inside the number layer so themes and
  // the border pipeline are unaffected. Safe SVG Tiny 1.2 features only.
  const highlightContent =
    highlighted && car
      ? `<rect x="6" y="6" width="132" height="132" rx="20" fill="none" stroke="#2ecc71" stroke-width="8"/>\n    `
      : "";

  const numberContent = highlightContent + (car ? carDisplayContent(car, textColor) : "");

  const resolvedTitle = resolveTitleSettings(selectorTemplate, getGlobalTitleSettings(), settings.titleOverrides, "");
  const titleContent =
    resolvedTitle.showTitle && resolvedTitle.titleText
      ? generateTitleText({
          text: resolvedTitle.titleText,
          fontSize: resolvedTitle.fontSize,
          bold: resolvedTitle.bold,
          position: resolvedTitle.position,
          customPosition: resolvedTitle.customPosition,
          fill: textColor,
        })
      : "";

  const border = resolveBorderSettings(selectorTemplate, getGlobalBorderSettings(), settings.borderOverrides);
  const borderSvg = generateBorderParts(border);

  const svg = renderIconTemplate(selectorTemplate, {
    ...colors,
    titleContent,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    numberContent,
  });

  return svgToDataUri(svg);
}
