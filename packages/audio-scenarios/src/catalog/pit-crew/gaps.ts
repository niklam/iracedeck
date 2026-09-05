/**
 * Gap callouts (issue #933): the Race Engineer's read on the time gaps to
 * the class-standings neighbors.
 *
 * Two scenarios, both `family: "gap"`:
 *   - `pit-crew.gap-trend` — fires on `gap.trendChanged` (the translator's
 *     relevance model: a neighbor's closing projection entering the
 *     time-to-contact horizon, or a breakaway opening up):
 *     "We're gaining on the car ahead. Gap is one point five seconds."
 *   - `pit-crew.gap-threshold` — fires on `gap.thresholdCrossed` (the live
 *     gap first dropped under the user's alert threshold): "We've caught the
 *     car ahead."
 *
 * Numbers are read LIVE at speak time (the #574 pattern) via the injected
 * live-gaps resolver, reusing the `lap-time-second` / `lap-time-decimal`
 * clip groups — a gap ≥ 60 s (or unavailable) skips the whole readout
 * clause, never half of it: all three readout vars resolve from the same
 * snapshot check.
 *
 * A single SHARED cooldown gates both scenarios (configurable 1–360 s,
 * default 30 s), claimed atomically in `where:` as the LAST gate — the
 * `tryClaimPositionAnnouncement` pattern, safe with `queueable` deferred
 * replays (which never re-run `where:`). Player-side clean-moment
 * suppression reuses the overtake gate (cars alongside / off-track /
 * crawling / pit road / recent incident); the translator already gated the
 * neighbor's side at emission.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { GapSide, SimEventOf } from "@iracedeck/event-bus";
import type { LiveGaps } from "@iracedeck/sim-events-iracing";

import { poolRef, WEIGHT } from "../../dsl.js";
import type { Scenario, Step } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { overtakeContextAllows, type OvertakeGateResolver } from "./overtake-gate.js";
import { POOL_REGISTRY } from "./pools.js";

const GAP_GROUP = "gap";
const LAP_TIME_GROUP_SECOND = "lap-time-second";
const LAP_TIME_GROUP_DECIMAL = "lap-time-decimal";

/** Resolver the plugin wires to `getLiveGaps()`; `null` = no live gap data. */
export type LiveGapsResolver = () => LiveGaps | null;

/** Default shared cooldown between gap callouts (ms). */
export const GAP_CALLOUT_DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Sanitize the `gapCalloutCooldownSeconds` global setting into milliseconds.
 * Clamps to 1–360 s; a missing / NaN value falls back to the 30 s default.
 *
 * Empty string and `null` are MISSING, not zero: `Number("")` and
 * `Number(null)` are both `0`, which is finite, so a bare numeric conversion
 * would clamp a cleared Property Inspector field to the 1 s minimum and
 * produce a callout every second. Same guard shape as
 * `sanitizeCornerCalloutLeadSeconds`.
 */
export function resolveGapCooldownMs(rawSeconds: unknown): number {
  const raw = typeof rawSeconds === "string" && rawSeconds !== "" ? Number(rawSeconds) : rawSeconds;

  if (typeof raw !== "number" || !Number.isFinite(raw)) return GAP_CALLOUT_DEFAULT_COOLDOWN_MS;

  return Math.min(360, Math.max(1, raw)) * 1000;
}

/** Shared-cooldown state across BOTH gap scenarios. */
let lastGapCalloutAt: number | null = null;

/**
 * Claim the shared gap-callout cooldown. Returns false (and claims nothing)
 * while a previous claim is inside `cooldownMs`. Claimed as the LAST
 * `where:` gate so a claim always results in an actual announcement.
 */
export function tryClaimGapCallout(now: number, cooldownMs: number): boolean {
  if (lastGapCalloutAt !== null && now - lastGapCalloutAt < cooldownMs) return false;

  lastGapCalloutAt = now;

  return true;
}

/** @internal Test-only reset for the shared cooldown. */
export function _resetGapCalloutCooldown(): void {
  lastGapCalloutAt = null;
}

/** The stashed identity of the last ACCEPTED gap event. */
type GapEventStash = { side: GapSide; direction: "closing" | "opening"; carIdx: number };

/** Last accepted gap event — read by the var resolvers at expansion time. */
let lastGapEvent: GapEventStash | null = null;

/** @internal Test-only stash override. */
export function _setLastGapEvent(event: GapEventStash | null): void {
  lastGapEvent = event;
}

/**
 * Split a speakable gap into whole seconds + tenths, or `null` when the live
 * gap for the stashed side is unavailable, negative, or ≥ 60 s (the reused
 * lap-time-second clips cover 0–59). All three readout vars resolve through
 * this one check so the clause always speaks whole or not at all.
 *
 * The live neighbor's `carIdx` must still match the announced one: a queued
 * fire can drain after the player has passed (or been passed by) the car the
 * line is about, and reading the NEW neighbor's gap would voice a number for
 * a different car than the line names. A mismatch drops the readout clause
 * and leaves the line itself intact.
 */
function resolveSpeakableGap(getLiveGaps: LiveGapsResolver): { seconds: number; tenths: number } | null {
  if (!lastGapEvent) return null;

  const live = getLiveGaps();
  const side = lastGapEvent.side === "ahead" ? live?.ahead : live?.behind;

  if (!side || side.carIdx !== lastGapEvent.carIdx) return null;

  if (side.gapSeconds === null || side.lapDelta !== 0) return null;

  const totalTenths = Math.round(side.gapSeconds * 10);

  if (totalTenths < 0 || totalTenths >= 600) return null;

  return { seconds: Math.floor(totalTenths / 10), tenths: totalTenths % 10 };
}

/**
 * Register the gap scenarios' variables. Must run before the scenarios are
 * defined — load-time validation rejects `{ var }` steps whose names aren't
 * registered.
 */
export function registerGapVars(engine: IScenarioEngine, getLiveGaps: LiveGapsResolver): void {
  // Trend-flip line, selected by the stashed event's side + direction.
  engine.defineVar("gap.line", () => {
    if (!lastGapEvent) return null;

    return poolRef(GAP_GROUP, `${lastGapEvent.side}-${lastGapEvent.direction}`);
  });

  // Threshold line, selected by the stashed event's side.
  engine.defineVar("gap.thresholdLine", () => {
    if (!lastGapEvent) return null;

    return poolRef(GAP_GROUP, `threshold-${lastGapEvent.side}`);
  });

  // "Gap is" + number + "point N seconds." — all three gate on the same
  // speakable-gap check so a partial readout can never play.
  engine.defineVar("gap.readoutIntro", () => {
    return resolveSpeakableGap(getLiveGaps) === null ? null : poolRef(GAP_GROUP, "readout-intro");
  });

  engine.defineVar("gap.second", () => {
    const gap = resolveSpeakableGap(getLiveGaps);

    return gap === null ? null : poolRef(LAP_TIME_GROUP_SECOND, String(gap.seconds));
  });

  engine.defineVar("gap.decimal", () => {
    const gap = resolveSpeakableGap(getLiveGaps);

    return gap === null ? null : poolRef(LAP_TIME_GROUP_DECIMAL, String(gap.tenths));
  });
}

/** The shared sequence tail: optional live-gap readout after the line. */
function gapReadoutClause(): Step {
  return { optional: [{ var: "gap.readoutIntro" }, { var: "gap.second" }, { var: "gap.decimal" }] };
}

/** Shared `where:` gating for both gap scenarios (minus the event narrowing). */
function gapWhereGates(
  getRaceFinishedFired: () => boolean,
  getGate: OvertakeGateResolver,
  getGapCooldownMs: () => number,
): boolean {
  if (getRaceFinishedFired()) return false;

  if (!overtakeContextAllows(getGate())) return false;

  // LAST gate: claim the shared cooldown only when everything else passed.
  return tryClaimGapCallout(Date.now(), getGapCooldownMs());
}

/** Build the trend-flip scenario ("we're gaining / they're pulling away"). */
export function buildGapTrendScenario(
  getRaceFinishedFired: () => boolean = () => false,
  getGate: OvertakeGateResolver = () => null,
  getGapCooldownMs: () => number = () => GAP_CALLOUT_DEFAULT_COOLDOWN_MS,
): Scenario {
  return {
    id: "pit-crew.gap-trend",
    when: {
      event: "gap.trendChanged",
      where: (ev) => {
        if (ev.event !== "gap.trendChanged") return false;

        const data = ev.data as SimEventOf<"gap.trendChanged">["data"];

        if (!gapWhereGates(getRaceFinishedFired, getGate, getGapCooldownMs)) return false;

        // Stash AFTER every gate (the #922 convention, see `incidents.ts`):
        // both gap scenarios are `queueable`, and a deferred fire re-resolves
        // its vars at drain time WITHOUT re-running `where:`. A suppressed
        // event writing the stash would make that queued fire speak the wrong
        // side / direction / car.
        lastGapEvent = { side: data.side, direction: data.direction, carIdx: data.carIdx };

        return true;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.CHATTER,
    queueable: true,
    family: "gap",
    sequence: [{ var: "gap.line" }, gapReadoutClause()],
  };
}

/** Build the threshold-crossing scenario ("we've caught the car ahead"). */
export function buildGapThresholdScenario(
  getRaceFinishedFired: () => boolean = () => false,
  getGate: OvertakeGateResolver = () => null,
  getGapCooldownMs: () => number = () => GAP_CALLOUT_DEFAULT_COOLDOWN_MS,
): Scenario {
  return {
    id: "pit-crew.gap-threshold",
    when: {
      event: "gap.thresholdCrossed",
      where: (ev) => {
        if (ev.event !== "gap.thresholdCrossed") return false;

        const data = ev.data as SimEventOf<"gap.thresholdCrossed">["data"];

        if (!gapWhereGates(getRaceFinishedFired, getGate, getGapCooldownMs)) return false;

        // Stash AFTER every gate — see the trend scenario above.
        lastGapEvent = { side: data.side, direction: "closing", carIdx: data.carIdx };

        return true;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.NORMAL,
    queueable: true,
    family: "gap",
    sequence: [{ var: "gap.thresholdLine" }, gapReadoutClause()],
  };
}

/**
 * Stable identifier for each user-toggleable gap callout (issue #933). One
 * id per callout type; each covers both sides (ahead + behind).
 */
export type GapCalloutId = "trend" | "threshold";

/**
 * Canonical mapping from `GapCalloutId` to its plugin-global setting key in
 * `GlobalSettingsSchema`.
 */
export const GAP_CALLOUT_SETTING_KEYS: Record<GapCalloutId, string> = {
  trend: "calloutEnabledGapTrend",
  threshold: "calloutEnabledGapThreshold",
};

// `as const` for the compile-time completeness check on `SCENARIO_ID_TO_GAP_ID`.
export const GAP_SCENARIO_IDS = ["pit-crew.gap-trend", "pit-crew.gap-threshold"] as const;

export const SCENARIO_ID_TO_GAP_ID: Record<(typeof GAP_SCENARIO_IDS)[number], GapCalloutId> = {
  "pit-crew.gap-trend": "trend",
  "pit-crew.gap-threshold": "threshold",
};

/**
 * Pool names this family draws from — the builder-family convention every
 * other catalog here follows, so the catalog tests can register them without
 * a hand-maintained list. Derived from `POOL_REGISTRY` by the `gap-` prefix
 * (the `START_LIGHT_POOL_NAMES` shape — the flags have no pool names at all
 * since #1064, their script addressing the clips as `pool:flags/<base>`, and
 * `FLAG_CLIP_SOURCES` is a literal list of those), so adding or renaming a
 * gap pool there flows through automatically.
 */
export const GAP_POOL_NAMES: readonly string[] = Object.keys(POOL_REGISTRY).filter((name) => name.startsWith("gap-"));
