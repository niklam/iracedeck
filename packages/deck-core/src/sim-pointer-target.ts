/**
 * Sim Pointer Target
 *
 * Where the Mouse to Sim pointer lands (issue #1029), as an anchor plus an
 * offset rather than the two fixed fractions #926 shipped.
 *
 * Pure and dependency-free by design: this module knows nothing about settings
 * storage, the native addon, or the feature that uses it. `mouse-pointer-service`
 * stays the injected OS primitive, the persisted choice is four
 * `GlobalSettingsSchema` fields, and composing the three is feature policy in
 * `@iracedeck/iracing-actions`' `shared/mouse-to-sim.ts` — the same split that
 * already keeps focus and pointer movement independent of each other.
 *
 * Total on purpose: the input crosses a persistence boundary (a hand-edited
 * settings file, or one written by a future schema), so an unknown anchor or a
 * non-finite offset resolves to the default rather than producing a NaN that the
 * native call would turn into an arbitrary cursor position.
 */

/** Horizontal anchors, in the order the settings window lists them. */
export const POINTER_ANCHORS_X = ["left", "center", "right"] as const;

export type PointerAnchorX = (typeof POINTER_ANCHORS_X)[number];

/** Vertical anchors, in the order the settings window lists them. */
export const POINTER_ANCHORS_Y = ["top", "middle", "bottom"] as const;

export type PointerAnchorY = (typeof POINTER_ANCHORS_Y)[number];

/** Each horizontal anchor as a fraction of the client area's width. */
export const POINTER_ANCHOR_X_FRACTIONS: Record<PointerAnchorX, number> = {
  left: 0,
  center: 0.5,
  right: 1,
};

/** Each vertical anchor as a fraction of the client area's height. */
export const POINTER_ANCHOR_Y_FRACTIONS: Record<PointerAnchorY, number> = {
  top: 0,
  middle: 0.5,
  bottom: 1,
};

/** Horizontally centered — half the client area's width. */
export const DEFAULT_POINTER_ANCHOR_X: PointerAnchorX = "center";

/** Measured down from the top edge, which is what the default offset is relative to. */
export const DEFAULT_POINTER_ANCHOR_Y: PointerAnchorY = "top";

/** No horizontal shift: the default target sits on the horizontal centre line. */
export const DEFAULT_POINTER_OFFSET_X = 0;

/**
 * An eighth of the client area's height below the top anchor — iRacing's own
 * top-of-screen UI band, which is what #926 shipped and where the pointer must
 * keep landing for anyone who never opens the setting.
 */
export const DEFAULT_POINTER_OFFSET_Y = 12.5;

/**
 * Largest offset either axis accepts, in percent of the client area.
 *
 * 50 is exactly the span between two neighbouring anchors, so every point in the
 * window is reachable — and reachable from the nearest anchor, which is the one a
 * user would pick anyway. A wider range would only add ways to express a target
 * that the clamp then pulls back to an edge.
 */
export const POINTER_OFFSET_LIMIT = 50;

/** A pointer target as the user configured it. */
export interface SimPointerTargetConfig {
  /** Horizontal anchor. */
  anchorX: PointerAnchorX;
  /** Vertical anchor. */
  anchorY: PointerAnchorY;
  /** Shift from the horizontal anchor, in percent of the client area's width; positive moves right. */
  offsetX: number;
  /** Shift from the vertical anchor, in percent of the client area's height; positive moves down. */
  offsetY: number;
}

/** A pointer target in the form {@link SimPointerMover} takes. */
export interface SimPointerTarget {
  /** 0 = left edge, 1 = right edge. */
  xFraction: number;
  /** 0 = top edge, 1 = bottom edge. */
  yFraction: number;
}

/** Keep a resolved target inside the client area. The native call clamps too, but a NaN must never reach it. */
function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;

  return Math.min(1, Math.max(0, value));
}

/** One axis: the anchor's fraction plus the offset, which is a percentage of that axis' extent. */
function resolveAxis(anchorFraction: number, offsetPercent: number): number {
  const offset = Number.isFinite(offsetPercent) ? offsetPercent : 0;

  return clampFraction(anchorFraction + offset / 100);
}

/**
 * Resolve a configured anchor + offset into the client-area fractions the pointer
 * mover takes.
 *
 * @param config - the user's configured target
 * @returns the target as fractions of the iRacing window's client area
 */
export function resolveSimPointerTarget(config: SimPointerTargetConfig): SimPointerTarget {
  const anchorX = POINTER_ANCHOR_X_FRACTIONS[config.anchorX] ?? POINTER_ANCHOR_X_FRACTIONS[DEFAULT_POINTER_ANCHOR_X];
  const anchorY = POINTER_ANCHOR_Y_FRACTIONS[config.anchorY] ?? POINTER_ANCHOR_Y_FRACTIONS[DEFAULT_POINTER_ANCHOR_Y];

  return {
    xFraction: resolveAxis(anchorX, config.offsetX),
    yFraction: resolveAxis(anchorY, config.offsetY),
  };
}
