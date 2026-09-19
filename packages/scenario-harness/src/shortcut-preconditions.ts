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
 */
export type ShortcutPrecondition = "player-car-index";

type PreconditionRule = {
  /** True when the harness satisfies the requirement. */
  satisfied: (sessionInfo: Record<string, unknown> | null) => boolean;
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
    satisfied: namesPlayerCar,
    reason:
      "Apply a session preset first. This sequence's caution lines read the driver list to work out which car is yours " +
      "(DriverInfo.DriverCarIdx), so without one the follow-car, restart-position and lane lines are all silent while the " +
      'flag lines still play — a half-silent run that reads as broken callouts. The "race" preset is the one the ' +
      'description asks for; "race-oval" is the same 18-car field on an oval, which additionally names the lane a ' +
      "double-file restart forms up in.",
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
  sessionInfo: Record<string, unknown> | null,
): string | null {
  for (const name of preconditions ?? []) {
    const rule = PRECONDITION_RULES[name];

    if (!rule.satisfied(sessionInfo)) return rule.reason;
  }

  return null;
}
