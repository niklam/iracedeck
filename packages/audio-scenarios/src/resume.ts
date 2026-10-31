/**
 * Resume (issue #1514): the pure half of continuing a fire an `interrupt` cut
 * (issue #758) — where a cut fire left off (`buildResumeState`), whether a
 * fresh expansion may continue from there and what it then plays
 * (`planResume`), and the op comparison both rest on (`opsEqual`). Nothing
 * here touches a bus, a pool or a timer: the scheduler stashes what
 * `buildResumeState` returns, hands the stash and the re-expansion to
 * `planResume` at idle-replay, and acts on the plan — the pool restore, the
 * log line and the bus take stay with it.
 */
import { AudioChannel } from "@iracedeck/audio-service";

import type { ActiveFireView, ExecOp, ResumeState } from "./engine-types.js";

/**
 * What a stashed resume is checked against (issue #1136), read at the call
 * rather than captured: the active voice and the scripts' expansion
 * generation may both have moved since the stash, and the manifest's open
 * tick — read only for the legacy by-path re-key — may have been swapped by
 * `setManifest`.
 */
export type ResumeWorld = {
  activeVoice: () => string | null;
  generation: () => number;
  openTick: () => string;
};

/**
 * What `executeFire` plays for a fire that may carry a resume: `fresh` when
 * there is nothing to continue from (no resume, or one at the head or past
 * the end of the fresh expansion — the fire plays from the top and nothing
 * is said); `whole` when the stash may not continue (`blocked` names why, for
 * the scheduler's debug line) and the fire plays from the top; `resume` with
 * the ops still to be heard — the re-key preroll ahead of the tail — the
 * tail's position in the fresh expansion, the preroll's length, and `head`,
 * the stashed ops delivered before the cut, whose pool takes the scheduler
 * puts back (issue #1136).
 */
export type ResumePlan =
  | { kind: "fresh" }
  | { kind: "whole"; blocked: string }
  | { kind: "resume"; ops: ExecOp[]; sourceStart: number; prerollCount: number; head: readonly ExecOp[] };

/**
 * Capture where an interrupted fire left off, mapped back to its ORIGINAL
 * expansion via the fire's source fields — so a resumed fire that is cut
 * again still stashes an absolute position, not one relative to its tail
 * (issue #758). `active.index` points one past the op in flight; the resume
 * replays that op from its start.
 *
 * `voice` and `generation` stamp the state of the world the ops were expanded
 * under, which `planResume` re-checks before it continues (issue #1136).
 */
export function buildResumeState(
  active: ActiveFireView,
  voice: string | null,
  generation: number,
): ResumeState | undefined {
  const playIndex = Math.max(0, active.index - 1);
  const sourceIndex = active.sourceStart + Math.max(0, playIndex - active.prerollCount);

  if (sourceIndex >= active.sourceOps.length) return undefined;

  return { ops: active.sourceOps, index: sourceIndex, voice, generation };
}

/**
 * Resume from an interrupt cut (issue #758): when the fresh expansion is
 * unchanged from the stashed one, continue from the interrupted clip
 * (re-keying the radio frame when it was already opened). A changed
 * expansion means the underlying state moved on while stashed — resuming
 * would speak a stale tail, so fall back to the full fresh replay (the
 * #481 freshness guarantee). `legacy` is whether the fire is a legacy
 * `Scenario` with a resolved sequence, which decides how `reopenPreroll`
 * finds the frame.
 */
export function planResume(
  resume: ResumeState | undefined,
  expanded: ExecOp[],
  legacy: boolean,
  world: ResumeWorld,
): ResumePlan {
  if (!resume || resume.index <= 0 || resume.index >= expanded.length) return { kind: "fresh" };

  const blocked = resumeBlocker(resume, expanded, world);

  if (blocked !== null) return { kind: "whole", blocked };

  const preroll = reopenPreroll(expanded, resume.index, legacy, world.openTick);

  return {
    kind: "resume",
    ops: [...preroll, ...expanded.slice(resume.index)],
    sourceStart: resume.index,
    prerollCount: preroll.length,
    head: resume.ops.slice(0, resume.index),
  };
}

/**
 * When the portion delivered before the cut had opened the radio frame,
 * the resumed tail re-keys with the frame's open so it doesn't restart
 * cold mid-sentence.
 *
 * The frame is known by its tag (issue #1064): the re-key is exactly the
 * ops tagged `open` that were delivered before the cut — a pack's own
 * beep, the ambience bed the cut stopped — as the user's switches left
 * them, never the built-in tick looked up by path. A tail that resumes
 * inside the open (a two-beep open cut at its second beep) gets the part
 * already delivered replayed ahead of it, which completes the open rather
 * than doubling it.
 *
 * One shape is still read by path: a LEGACY scenario whose expansion carries
 * no tag at all is a sequence playing the built-in tick inline (the catalog
 * has none since #1064, and #1065 retires the shape), and for that one the
 * re-key is the manifest's open tick, found by path, unless the tail itself
 * begins with it. A scripted contract never takes that route — a body of
 * its playing the tick as an ordinary clip has opened no frame.
 */
function reopenPreroll(expanded: ExecOp[], resumeIndex: number, legacy: boolean, openTick: () => string): ExecOp[] {
  const delivered = expanded.slice(0, resumeIndex);

  if (!legacy || expanded.some((op) => op.frame !== undefined)) {
    return delivered.filter((op) => op.frame === "open");
  }

  const tick = openTick();
  const frameWasOpened = delivered.some((op) => op.kind === "play" && op.path === tick);
  const first = expanded[resumeIndex];
  const resumesWithTick = first.kind === "play" && first.path === tick;

  if (!frameWasOpened || resumesWithTick) return [];

  return [{ kind: "play", channel: AudioChannel.SFX, path: tick }];
}

/**
 * Why a stashed resume may not continue into this fresh expansion, or
 * `null` when it may. Three things must hold, and only the first is the
 * #758 rule: the ops must match (`opsEqual`), the ACTIVE VOICE must be the
 * one the head was spoken in, and the engine's expansion `generation` must
 * be the one the head was expanded under (issue #1136).
 *
 * The last two used to be implied. `opsEqual` compared clip paths, and a
 * voice's paths name that voice, so a voice change failed the comparison
 * and replayed whole; a pack redefinition that changed a pool's members
 * usually changed a path too. Comparing a pool-drawn op by its POOL key
 * removes both accidents — the key is voice-independent and survives a
 * redefinition — so an all-pool body (which is every scripted readback)
 * would otherwise resume its tail in a voice the driver never heard the
 * head in. They are checked explicitly rather than folded into `opsEqual`
 * because they are facts about the WORLD between the two expansions, not
 * about the ops.
 */
function resumeBlocker(resume: ResumeState, expanded: readonly ExecOp[], world: ResumeWorld): string | null {
  if (resume.voice !== world.activeVoice()) return "voice changed while stashed";

  if (resume.generation !== world.generation()) return "scripts changed while stashed";

  if (!opsEqual(expanded, resume.ops)) return "the expansion changed while stashed";

  return null;
}

/**
 * Element-wise equality of two expanded op lists (plain data, no functions).
 * The frame tag is part of an op's identity: the same clip played as a frame
 * and as body are two different ops, and a resume must not mistake one for
 * the other.
 *
 * A play op that came out of a pool is compared by that POOL and its channel,
 * never by the take drawn (issue #1136): `noRepeat` plus the take committed on
 * acceptance make a re-expansion of a two-take pool draw the other take every
 * time, and which recording of a slot came up is not part of what the body
 * says — so a path comparison would fail every resume of a scripted readback.
 * A path-drawn op is compared by path and channel as before, and a pool-drawn
 * op is never equal to a path-drawn one. What the comparison still catches: a
 * var resolving to a different value is a different reference
 * (`pool:numbers/12` against `pool:numbers/13`), and a slot that appears,
 * disappears or reorders changes the shape.
 *
 * What it deliberately no longer catches, because a pool key is voice-
 * independent and survives a redefinition of what the pool holds: a change of
 * ACTIVE VOICE or of the scripts/manifest while the fire was stashed. Those
 * are facts about the world rather than about the ops, and `resumeBlocker`
 * checks them beside this — do not read a `true` from here as "nothing moved".
 */
export function opsEqual(a: readonly ExecOp[], b: readonly ExecOp[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];

    if (x.kind !== y.kind || x.frame !== y.frame) return false;

    if (x.kind === "play" && y.kind === "play") {
      if (x.channel !== y.channel) return false;

      if (x.pool !== undefined || y.pool !== undefined) {
        if (x.pool !== y.pool) return false;
      } else if (x.path !== y.path) return false;
    }

    if (x.kind === "ambient" && y.kind === "ambient" && x.action !== y.action) return false;

    if (x.kind === "pause" && y.kind === "pause" && x.ms !== y.ms) return false;
  }

  return true;
}
