/**
 * Preconditions a scenario shortcut can declare (issue #1127).
 *
 * A shortcut that drives the translator depends on harness state it does not
 * set up itself, and the failure mode when that state is missing is the worst
 * kind: PART of the run goes silent. Pressing a caution button with no session
 * preset applied plays every flag-driven line and drops every lineup-driven one
 * — `resolveCautionLineup` reads `DriverInfo.DriverCarIdx` to know who the
 * player is and returns `null` outright without it, while the caution's own
 * speak gate is flag-only — leaving nothing in the UI and one
 * `optional clause skipped — var {{caution.followCarNumber}} resolved to
 * nothing` in a debug log. A tester who hears that learns to distrust the
 * callouts rather than the setup.
 *
 * So a shortcut names what it needs, and the harness REFUSES to start it with
 * a message saying what is missing and how to fix it. It deliberately does not
 * fix it: the tester arranged whatever session state they have on purpose, and
 * a button that silently applies a preset over it is a worse surprise than a
 * refusal.
 *
 * The reason text lives on the rule rather than on each shortcut, so the three
 * caution buttons cannot drift from each other's wording.
 */
import { resolvePlayerCarIdx } from "@iracedeck/sim-events-iracing";

/**
 * What a shortcut can require of the harness before it will run.
 *
 * `player-car-index` — session info names the player's car. Every `caution.*`
 * script variable reads the lineup, which needs it.
 *
 * `sdk-connected` — the mock SDK is connected (#1349). The overtake gate reads
 * the translator's latest telemetry, which a disconnected translator never
 * receives, so an overtake or gap line would be refused by its own gate while
 * the button looked as if it had worked.
 */
export type ShortcutPrecondition = "player-car-index" | "sdk-connected";

/** The live harness state a precondition is checked against, read by the route on every start. */
export type HarnessPreconditionState = {
  sessionInfo: Record<string, unknown> | null;
  isConnected: boolean;
};

type PreconditionRule = {
  /** True when the harness satisfies the requirement. */
  satisfied: (state: HarnessPreconditionState) => boolean;
  /** What is missing and how to fix it. Shown to the tester verbatim. */
  reason: string;
};

/**
 * Whether session info names the player's car — asked of the translator's own
 * `resolvePlayerCarIdx`, the read this precondition exists to get ahead of,
 * rather than of a restatement of it. A restated rule drifts the moment the
 * resolver tightens, and a check that admits a value the resolver rejects lets
 * the half-silent run through anyway, which is the whole failure it is here to
 * prevent.
 */
function namesPlayerCar(sessionInfo: Record<string, unknown> | null): boolean {
  return resolvePlayerCarIdx(sessionInfo) !== null;
}

const PRECONDITION_RULES: Record<ShortcutPrecondition, PreconditionRule> = {
  "player-car-index": {
    satisfied: (state) => namesPlayerCar(state.sessionInfo),
    reason:
      "Apply a session preset first. This sequence's caution lines read the driver list to work out which car is yours " +
      "(DriverInfo.DriverCarIdx), so without one the follow-car, restart-position and lane lines are all silent while the " +
      'flag lines still play — a half-silent run that reads as broken callouts. The "race" preset is the one the ' +
      'description asks for; "race-oval" is the same 18-car field on an oval, which additionally names the lane a ' +
      "double-file restart forms up in.",
  },
  "sdk-connected": {
    satisfied: (state) => state.isConnected,
    reason:
      'Connect the mock SDK first (the "Connected" toggle in the header). This callout checks the overtake gate, which ' +
      "reads live telemetry: on track, at racing speed, off pit road, nobody alongside. The button puts the car there " +
      "itself, but a disconnected translator receives no telemetry, so the gate stays shut and the line is silent for " +
      "the wrong reason.",
  },
};

/**
 * The first unmet precondition's reason, or `null` when the shortcut may run.
 *
 * Necessary rather than sufficient, and deliberately so: a preset that names a
 * player car whose roster does not hold the rest of the field (`practice`, with
 * its empty driver list) still passes here and still resolves fewer lines than
 * the description promises. The bar is the one state whose absence silences the
 * lineup family WHOLESALE, not every state that could thin it out — a stricter
 * gate would start refusing runs the sequence supports.
 */
export function checkShortcutPreconditions(
  preconditions: readonly ShortcutPrecondition[] | undefined,
  state: HarnessPreconditionState,
): string | null {
  for (const name of preconditions ?? []) {
    const rule = PRECONDITION_RULES[name];

    if (!rule.satisfied(state)) return rule.reason;
  }

  return null;
}
