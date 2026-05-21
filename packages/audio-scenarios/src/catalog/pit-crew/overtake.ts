/**
 * Race Engineer overtake callouts — issue #574.
 *
 * Two scenarios under the shared `family: "overtake"` so a fast sequence of
 * position swaps doesn't stack stale callouts (the engine preempts the
 * in-flight family-mate when a fresher fire arrives):
 *
 *   - `pit-crew.overtake-gained` — fires on `overtake.completed`. Two
 *     branches selected at expansion time via the `isLeader` flag on the
 *     event payload:
 *       * **Leader** (`isLeader === true`): one self-contained clip,
 *         "Nice pass! We're now leading race. Let's keep it that way!"
 *       * **Otherwise**: composed three-part — "Nice pass." +
 *         "That puts us to" + "P[n]" (the second reuses the
 *         `position-intro-better` clip shipped for #566; the third reuses
 *         the existing `position-number/<N>` pool).
 *
 *   - `pit-crew.overtake-lost` — fires on `overtake.lost`. Composed
 *     four-part — "Come on," + "<driver name>" + ". Don't give up
 *     positions like that. We're now in" + "P[n]". The driver-name slot
 *     reuses the existing `session-start-greeting/<driverName>` pool from
 *     #542 — same name the engineer uses when greeting the driver at
 *     session start.
 *
 * Both scenarios pick the EFFECTIVE position (class in multi-class series,
 * overall otherwise) the same way `lap.completed` consumers do — multi-class
 * drivers care about their class rank, not the mixed-field order.
 *
 * Snapshot-at-fire-time pattern: the var resolvers read closures bound to
 * the most recent payload for each event, cached by the plugin. Two
 * separate caches (gain and loss) because the events are distinct.
 *
 * Driver-name fallback: when the resolved driver name isn't in the greeting
 * pool, `resolveActiveDriverName(... , "driver")` falls back to the
 * pre-recorded `"driver"` clip — the line becomes "Come on, driver. Don't
 * give up positions..." cleanly.
 *
 * `where:` filters in both scenarios:
 *   - Effective position is in the announceable range (`POSITION_NUMBER_MIN..MAX`).
 *     Out-of-range positions cause the scenario not to fire at all rather than
 *     producing a partial readout.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario, Step } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { POSITION_NUMBER_MAX, POSITION_NUMBER_MIN, positionNumberIsSpeakable } from "./position.js";

/**
 * Resolver for the most recent `overtake.completed` payload. Returns `null`
 * when no gain has occurred yet — the scenario's `where:` short-circuits
 * before it gets here, but the var resolvers still guard against it
 * defensively in case of a deferred-replay edge case.
 */
export type OvertakeGainedSnapshotResolver = () => SimEventOf<"overtake.completed">["data"] | null;

/** Resolver for the most recent `overtake.lost` payload. Same shape as the gain resolver. */
export type OvertakeLostSnapshotResolver = () => SimEventOf<"overtake.lost">["data"] | null;

/**
 * Resolver for the active driver name. Plugins wire this to
 * `resolveActiveDriverName(driverNames, "driver")` — returns the user-picked
 * name when valid, the pre-recorded `"driver"` fallback otherwise, or `null`
 * only when no driver-name clips exist at all.
 */
export type OvertakeDriverNameResolver = () => string | null;

const OVERTAKE_BASE = "position-overtake";
const POSITION_NUMBER_GROUP = "position-number";
const POSITION_INTRO_BETTER_GROUP = "position-intro-better";
const SESSION_START_GREETING_GROUP = "session-start-greeting";

/** Build a full `voice/{voice}/...` path for a `var` resolver (no base applied). */
function voicePath(group: string, name: string): string {
  return `voice/{voice}/${group}/${name}.mp3`;
}

/** Build a `clip` step path relative to the scenario's `voice/{voice}` base. */
function clipPath(filename: string): string {
  return `${OVERTAKE_BASE}/${filename}`;
}

/**
 * Pick the effective overall vs class position from an overtake payload.
 * Multi-class series → class fields; single-class (or unknown) → overall.
 * Returns `null` when the chosen current position is missing — the scenario
 * stays silent.
 */
function selectEffectiveOvertakePosition(data: {
  position: number;
  classPosition?: number;
  isMultiClass?: boolean;
}): number | null {
  const useClass = data.isMultiClass === true;
  const current = useClass ? data.classPosition : data.position;

  return typeof current === "number" && current > 0 ? current : null;
}

/**
 * Whether an `overtake.completed` payload should produce an audible callout.
 * The effective position must be inside the speakable range; everything else
 * is enforced by the translator (race-only, hold sustained, gap satisfied,
 * sim-glitch suppressed).
 */
export function overtakeGainIsAnnounceable(data: SimEventOf<"overtake.completed">["data"]): boolean {
  const current = selectEffectiveOvertakePosition(data);

  return current !== null && positionNumberIsSpeakable(current);
}

/**
 * Whether an `overtake.lost` payload should produce an audible callout.
 * Symmetric with {@link overtakeGainIsAnnounceable} — same speakable-position
 * check; the translator has already enforced gate / gap / race-only rules.
 */
export function overtakeLossIsAnnounceable(data: SimEventOf<"overtake.lost">["data"]): boolean {
  const current = selectEffectiveOvertakePosition(data);

  return current !== null && positionNumberIsSpeakable(current);
}

/**
 * Register the overtake scenarios' variables on the scenario engine. Must run
 * before the scenarios are defined — load-time validation rejects a `{ var }`
 * step whose name isn't registered.
 *
 * `getGainedSnapshot` / `getLostSnapshot` are independent: the gain scenario
 * reads the former, the loss scenario reads the latter. `getDriverName`
 * supplies the pre-resolved driver-name key for the loss line.
 */
export function registerOvertakeVars(
  engine: IScenarioEngine,
  getGainedSnapshot: OvertakeGainedSnapshotResolver,
  getLostSnapshot: OvertakeLostSnapshotResolver,
  getDriverName: OvertakeDriverNameResolver,
): void {
  engine.defineVar("overtake.gained.number", () => {
    const s = getGainedSnapshot();

    if (!s) return null;

    const current = selectEffectiveOvertakePosition(s);

    if (current === null || !positionNumberIsSpeakable(current)) return null;

    return voicePath(POSITION_NUMBER_GROUP, String(current));
  });

  engine.defineVar("overtake.lost.number", () => {
    const s = getLostSnapshot();

    if (!s) return null;

    const current = selectEffectiveOvertakePosition(s);

    if (current === null || !positionNumberIsSpeakable(current)) return null;

    return voicePath(POSITION_NUMBER_GROUP, String(current));
  });

  engine.defineVar("overtake.lost.driverName", () => {
    const name = getDriverName();

    return name ? voicePath(SESSION_START_GREETING_GROUP, name) : null;
  });
}

/**
 * Build the gained-overtake scenario. The `if:` branch reads the snapshot at
 * expansion time so a deferred replay picks the same leader / non-leader
 * branch as the original fire.
 */
export function buildOvertakeGainedScenario(getSnapshot: OvertakeGainedSnapshotResolver): Scenario {
  const sequence: Step[] = [
    "@pit-crew.radio-open",
    {
      if: () => {
        const s = getSnapshot();

        return s !== null && s.isLeader;
      },
      then: [clipPath("nice-pass-leader-01.mp3")],
      else: [
        clipPath("nice-pass-01.mp3"),
        `${POSITION_INTRO_BETTER_GROUP}/that-puts-us-to-01.mp3`,
        { var: "overtake.gained.number" },
      ],
    },
    "@pit-crew.radio-close",
  ];

  return {
    id: "pit-crew.overtake-gained",
    when: {
      event: "overtake.completed",
      where: (ev) => {
        if (ev.event !== "overtake.completed") return false;

        return overtakeGainIsAnnounceable(ev.data as SimEventOf<"overtake.completed">["data"]);
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
    family: "overtake",
    sequence,
  };
}

/**
 * Build the lost-position scenario. Composes the four-part sequence. The
 * snapshot resolver passed to {@link registerOvertakeVars} powers the
 * per-clip `var` resolvers; the scenario itself reads the event's `data`
 * inline in `where:` and doesn't need the resolver here, so the parameter
 * is accepted for API symmetry with {@link buildOvertakeGainedScenario}
 * (every plugin call site passes both) but the body doesn't reference it.
 */
export function buildOvertakeLostScenario(_getSnapshot: OvertakeLostSnapshotResolver): Scenario {
  const sequence: Step[] = [
    "@pit-crew.radio-open",
    clipPath("come-on-01.mp3"),
    { var: "overtake.lost.driverName" },
    clipPath("dont-give-up-positions-01.mp3"),
    { var: "overtake.lost.number" },
    "@pit-crew.radio-close",
  ];

  return {
    id: "pit-crew.overtake-lost",
    when: {
      event: "overtake.lost",
      where: (ev) => {
        if (ev.event !== "overtake.lost") return false;

        return overtakeLossIsAnnounceable(ev.data as SimEventOf<"overtake.lost">["data"]);
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
    family: "overtake",
    sequence,
  };
}

/**
 * Stable identifier for each user-toggleable overtake callout (issue #574).
 * One id per direction so the user can independently silence "gained" or
 * "lost" announcements (drivers who want congratulations but not chastisement,
 * or vice versa, get per-direction control).
 */
export type OvertakeCalloutId = "gained" | "lost";

/**
 * Canonical mapping from `OvertakeCalloutId` to its plugin-global setting key
 * in `GlobalSettingsSchema`. Plugin entry points use this to read the live
 * opt-in without duplicating the key strings.
 */
export const OVERTAKE_CALLOUT_SETTING_KEYS: Record<OvertakeCalloutId, string> = {
  gained: "calloutEnabledOvertakeGained",
  lost: "calloutEnabledOvertakeLost",
};

// `as const` so the element type is a literal union the
// `SCENARIO_ID_TO_OVERTAKE_ID` map below can be typed against — TS errors
// out at build time if a scenario id is renamed, missing, or extra.
export const OVERTAKE_SCENARIO_IDS = ["pit-crew.overtake-gained", "pit-crew.overtake-lost"] as const;

export const SCENARIO_ID_TO_OVERTAKE_ID: Record<(typeof OVERTAKE_SCENARIO_IDS)[number], OvertakeCalloutId> = {
  "pit-crew.overtake-gained": "gained",
  "pit-crew.overtake-lost": "lost",
};

/**
 * Re-exported announceable range for the overtake number readout — matches
 * the position-change scenario (`position-number/<1..64>` covers the iRacing
 * field-size spectrum). Kept here so callers don't reach across into
 * position.ts directly.
 */
export { POSITION_NUMBER_MAX as OVERTAKE_POSITION_MAX, POSITION_NUMBER_MIN as OVERTAKE_POSITION_MIN };

/**
 * Empty — the overtake readouts are composed from `engine.defineVar` resolvers
 * plus static clip paths, not pools. Exported for parity with the
 * family-completeness check used by the other pit-crew catalog files.
 */
export const OVERTAKE_POOL_NAMES: readonly string[] = [];
