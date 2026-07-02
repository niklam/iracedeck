/**
 * Race Admin — Car Selector helpers (issue #732)
 *
 * The `select-car` Race Admin mode turns a Stream Deck key into a "placeholder"
 * car button: it derives its slot from its grid position, shows the matching
 * car's number, and on press stores that car's `CarIdx` as the shared admin
 * target (read back by the `selected-car` driver target). These are the pure,
 * side-effect-free pieces (slot math, session→car resolution, icon rendering)
 * so they can be unit-tested without the action lifecycle.
 *
 * Layout convention (the standard iRaceDeck selector layout, baked here):
 *   - top-left           = Back to default profile
 *   - bottom-left        = Previous page
 *   - bottom-right       = Next page
 * Every other cell is a car slot, filled row-major (left→right, top→bottom),
 * skipping those three reserved cells. The field is sorted by car number
 * (pace car excluded). See `.claude/rules/profiles-and-devices.md`.
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
 * target as a `{ carIdx, carNumber }` record. Follows the `_`-prefixed
 * convention for shared internal state (like `_warnings` / `_lastSeenVersion`)
 * — no schema field. The car number is stored alongside the CarIdx as a
 * staleness guard: CarIdx assignments are session-scoped while global settings
 * persist across sessions, so a reader must treat the selection as void when
 * the CarIdx no longer resolves to the stored number (see
 * `resolveSelectedCar`).
 */
export const SELECTED_CAR_KEY = "_raceAdminSelectedCar" as const;

/** The profile a select-car press switches to when none is configured. */
export const DEFAULT_SELECTOR_TARGET_PROFILE = "iRaceDeck Race Admin Per Car" as const;

/**
 * Bundled profile names available for a device type, read from the generated
 * `data/profiles.json` (mirrors the manifest). Feeds the Target Profile
 * dropdown's `_deviceProfiles` list; same shape as the Switch Profile action's
 * helper of the same name.
 *
 * @internal Exported for testing
 */
export function availableProfilesForDevice(deviceType: number | undefined): string[] {
  if (deviceType === undefined) return [];

  return profilesData.filter((p) => p.deviceType === deviceType).map((p) => p.name);
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

/**
 * The three reserved (navigation) cells as row-major linear indices, deduped —
 * on degenerate grids (single row/column) the corners coincide.
 */
function reservedLinear(cols: number, rows: number): Set<number> {
  const topLeft = 0;
  const bottomLeft = (rows - 1) * cols;
  const bottomRight = (rows - 1) * cols + (cols - 1);

  return new Set([topLeft, bottomLeft, bottomRight]);
}

/**
 * Number of car slots available per page for a device grid: every cell minus
 * the reserved navigation cells (three on a normal grid; fewer coincide on a
 * degenerate single-row/column grid). `0` when the grid is unknown or has no
 * free cell.
 *
 * @internal Exported for testing
 */
export function carsPerPage(grid: readonly [number, number] | null | undefined): number {
  if (!grid) return 0;

  const [cols, rows] = grid;

  if (cols <= 0 || rows <= 0) return 0;

  return Math.max(0, cols * rows - reservedLinear(cols, rows).size);
}

/**
 * Compute the 0-based field index a selector button represents from its grid
 * position + page. Returns `null` when the cell is a reserved navigation cell,
 * the coordinates are out of range, or the grid is unknown/too small.
 *
 * @internal Exported for testing
 */
export function computeCarSlotIndex(
  column: number,
  row: number,
  grid: readonly [number, number] | null | undefined,
  page: number,
): number | null {
  if (!grid) return null;

  const [cols, rows] = grid;

  if (carsPerPage(grid) === 0) return null;

  if (column < 0 || row < 0 || column >= cols || row >= rows) return null;

  const linear = row * cols + column;
  const reserved = reservedLinear(cols, rows);

  if (reserved.has(linear)) return null;

  const reservedBefore = [...reserved].filter((r) => r < linear).length;
  const inPage = linear - reservedBefore;
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 0;

  return safePage * carsPerPage(grid) + inPage;
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
  const numberText = `<text x="72" y="78" text-anchor="middle" dominant-baseline="central" fill="${textColor}" font-family="Arial, sans-serif" font-size="${NUMBER_FONT_SIZE}" font-weight="bold">${escapeXml(car.carNumber)}</text>`;

  const name = car.lastName?.trim().toUpperCase() ?? "";

  if (!name) return numberText;

  const nameFontSize = Math.max(11, Math.min(22, Math.floor(130 / (0.68 * name.length))));
  const nameText = `<text x="72" y="121" text-anchor="middle" dominant-baseline="central" fill="${textColor}" font-family="Arial, sans-serif" font-size="${nameFontSize}" font-weight="bold">${escapeXml(name)}</text>`;

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
export function generateSelectorSvg(car: SelectorDisplayCar | null, settings: SelectorRenderSettings): string {
  const colors = resolveIconColors(selectorTemplate, getGlobalColors(), settings.colorOverrides);
  const textColor = colors.textColor;

  const numberContent = car ? carDisplayContent(car, textColor) : "";

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
