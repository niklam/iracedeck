/**
 * The rolling-start formation: the "pace car is moving" cue (issue #660), the
 * formation as a state the callouts can ask about, and a change to the car the
 * player forms up behind (issue #1167).
 *
 * **The cue** fires once the instant the field begins rolling behind the pace
 * car at the START of a rolling start — detected as the entry edge into
 * `ParadeLaps` (`SessionState` rising into `ParadeLaps` from any other state,
 * e.g. `Warmup→ParadeLaps`). That is the moment iRacing releases the grid into
 * the formation/parade lap.
 *
 * **Rolling-only.** Standing starts get the gantry lights + numeric countdown
 * (`diff/start-lights.ts`), not a pace car, so they are excluded here via
 * `resolveStandingStart`. Standing grids also never enter `ParadeLaps`, but the
 * explicit gate keeps the cue rolling-only regardless.
 *
 * **Gating split.** Race-session + in-car gating is deliberately NOT done here —
 * it lives at the audio-scenarios `where:` layer. Keeping this diff to the bare
 * telemetry edge means the event stays firable from the scenario harness (which
 * drives bus events directly) while the production callout still respects the
 * session/in-car context.
 *
 * **Seed on first tick.** The first tick after connect seeds the baseline
 * without firing, so connecting mid-parade never blurts the line (same caveat
 * as the gantry bits / pace-lap diff).
 *
 * **Re-entry re-fires.** A genuine re-entry into `ParadeLaps` (a re-grid) is a
 * fresh entry edge and legitimately fires again — the diff holds no
 * once-per-session latch.
 *
 * **The formation is one state, held here and read by everything.** It runs
 * from that entry edge until the session leaves `ParadeLaps` or `GreenHeld` or
 * `Green` is set, whichever comes first — in the 2026-09-17 capture
 * (`__fixtures__/rolling-start-formation-20260917.json`) from 126.67 s to the
 * green being held at 186.28 s, 14.9 s before the green itself. The translator
 * exposes it as `getRollingStartFormation()`, and `isRollingStartFormation()`
 * is that reader not being `null`, so the diff that reports a lineup change
 * and the gate that lets a formation call speak are one derivation and cannot
 * disagree. Once the green is held the formation is over for the engineer: the
 * green-held line owns the moment, and a queued formation call must not drain
 * into the launch. It is a latch, not a reading of the bits: a `GreenHeld`
 * withdrawn inside `ParadeLaps` — never observed — does not reopen it. Only a
 * new entry edge does.
 *
 * It has an IDENTITY, the counterpart of the caution's episode (issue #1286):
 * an id from a counter no state reset touches, and the first follow car the
 * formation could read. A consumer that remembers the car the engineer last
 * named keys that memory on the id, so nothing carries from one formation into
 * a re-grid or a later session.
 *
 * **A formation already running on the diff's first tick is adopted,
 * silently.** The first tick emits nothing, as it never has: no cue, and no
 * lineup change, since the lineup it reads there is the baseline. What it does
 * do is record that a formation is running when the tick shows one — a rolling
 * start in `ParadeLaps` with the green neither held nor out — the way the
 * caution diff takes a caution that is already out for a live one. "Never
 * blurt on connect" is a rule about events, and this is a state: left unset, a
 * plugin restarted during the formation would refuse the one thing that can
 * still happen in it, a real change to the car ahead, for the rest of the
 * formation. The same tick closes a formation the tick contradicts, which is
 * how one that ended while the driver looked at the replay cannot survive as a
 * latch — the formation's id and first follow car ride through the replay
 * wipe, the baselines do not (`wipeStateForReplay`).
 *
 * **A change to the car ahead** is `rollingStart.lineup.changed`, the mirror
 * of `diffLineup` in `diff/caution.ts`. The follow car is held rather than
 * diffed against the previous tick, because the lineup can go unreadable for a
 * tick — no session info, a player the grid has not placed — and a gap is an
 * absence of news rather than a change. Three things it does not report: the
 * formation's first lineup, which answers "who do I form up behind" rather
 * than changing it; a follow car it cannot name; and anything outside the
 * formation, where the lineup is not even resolved — so on every racing tick
 * the pace arrays are not walked here at all. That last one is also what keeps
 * the post-green unwind quiet: the rows renumber on almost every tick from
 * 2.7 s after the green, and the formation ended 15 s before it. The event
 * carries nothing; the callout reads the lineup live when it speaks.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import { Flags, hasFlag, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";

import { resolveStandingStart } from "../start-lights.js";
import type { TranslatorState } from "../state.js";
import { resolvePaceLineup } from "./pace-lineup.js";
import type { EmitFn } from "./types.js";

/**
 * The next formation's id (issue #1167). Module-level and never reset, so a
 * formation in a later session — `resetPerSessionState` builds a fresh state —
 * can never reuse an id a consumer still remembers. Its own counter, not the
 * caution's: an id is only ever compared with another of its own kind.
 */
let nextRollingStartFormationId = 1;

/** A new formation: a fresh id, and nothing known of its lineup yet. */
function openFormation(state: TranslatorState): void {
  state.rollingStartFormationId = nextRollingStartFormationId++;
  state.rollingStartFirstFollowCarIdx = null;
  state.rollingStartFollowCarIdx = null;
}

/** No formation runs: the identity and the lineup it held go together. */
function closeFormation(state: TranslatorState): void {
  state.rollingStartFormationId = null;
  state.rollingStartFirstFollowCarIdx = null;
  state.rollingStartFollowCarIdx = null;
}

/**
 * The car to form up behind changing, while a formation runs — see the module
 * comment. Resolves the lineup itself, and only past its early return, so
 * outside a formation nothing is resolved.
 */
function diffFormationLineup(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn<(typeof ROLLING_START_EVENTS)[number]>,
): void {
  if (state.rollingStartFormationId === null) return;

  // Only the follow car is read, and it does not depend on the track being an
  // oval — that argument decides the lane's name alone — so the track category
  // is not looked up for it.
  const lineup = resolvePaceLineup(telemetry, sessionInfo, false);

  if (lineup === null || lineup.followCarIdx === null) return;

  const was = state.rollingStartFollowCarIdx;

  state.rollingStartFollowCarIdx = lineup.followCarIdx;

  // The formation's first lineup, kept for `getRollingStartFormation()` — never
  // moved by a change, so a consumer can tell a return to it from a new car.
  if (state.rollingStartFirstFollowCarIdx === null) state.rollingStartFirstFollowCarIdx = lineup.followCarIdx;

  if (was === null || was === lineup.followCarIdx) return;

  emit({ event: "rollingStart.lineup.changed", data: {} });
}

/** The events {@link diffRollingStart} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const ROLLING_START_EVENTS = [
  "rollingStart.lineup.changed",
  "rollingStart.pace-car-moving.raised",
] as const satisfies readonly SimEventName[];

export function diffRollingStart(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn<(typeof ROLLING_START_EVENTS)[number]>,
): void {
  const sessionState = typeof telemetry.SessionState === "number" ? telemetry.SessionState : SessionState.Invalid;
  const inParade = sessionState === SessionState.ParadeLaps;
  const flags = telemetry.SessionFlags ?? 0;
  // What a running formation looks like on one tick: in `ParadeLaps`, with the
  // green neither held nor out. A tick that is not this ENDS a formation;
  // only the entry edge (or the seed, below) starts one.
  const formationTick = inParade && !hasFlag(flags, Flags.GreenHeld) && !hasFlag(flags, Flags.Green);

  // First tick — seed the baseline without firing (connecting mid-parade must
  // not blurt the line). The formation itself is a state, not an event: one
  // the tick shows running is adopted, one it contradicts is closed, and one
  // carried through a replay wipe that is still running is left as it is.
  if (!state.rollingStartInitialized) {
    state.rollingStartInitialized = true;
    state.lastInParadeLaps = inParade;

    if (!formationTick) {
      closeFormation(state);
    } else if (state.rollingStartFormationId === null && !resolveStandingStart(sessionInfo)) {
      openFormation(state);
    }

    // The lineup on this tick is the baseline, whatever was held before: the
    // seed never reports a change.
    state.rollingStartFollowCarIdx = null;
    diffFormationLineup(state, telemetry, sessionInfo, emit);

    return;
  }

  // Entry edge — a genuine `*→ParadeLaps` transition. Rolling start only:
  // standing grids get the gantry/countdown, not a pace car.
  const entered = inParade && !state.lastInParadeLaps && !resolveStandingStart(sessionInfo);

  state.lastInParadeLaps = inParade;

  if (!formationTick) {
    closeFormation(state);
  } else if (entered) {
    openFormation(state);
  }

  // Before the cue is emitted, so the formation and its first follow car are
  // both in place for anything that hears it. On the entry tick this seeds the
  // baseline and reports nothing.
  diffFormationLineup(state, telemetry, sessionInfo, emit);

  if (entered) emit({ event: "rollingStart.pace-car-moving.raised", data: {} });
}
