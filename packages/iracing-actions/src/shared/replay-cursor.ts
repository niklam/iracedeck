/**
 * Replay cursor ownership (#1203).
 *
 * iRacing has one replay cursor, and several actions move it: Replay Control's
 * transport and search modes, its Jump to Fastest Lap walk (a multi-second
 * sequence of probes), and Replay Markers' Next / Previous. A walk that keeps
 * probing after the user has jumped elsewhere overrides the user's command with
 * its next probe — and can take the user's landing as its own search result,
 * then record it as a lap start. So the cursor has a single owner, module-wide:
 *
 * - A long-running driver (the walk) **claims** the cursor for the duration and
 *   checks `cancelledBy` at every await — a non-null value means "stop, send
 *   nothing more".
 * - Any one-shot command, in ANY action, calls {@link cancelReplayCursorOwner}
 *   before sending it — a speed change or a pause too, not only a seek, since
 *   either breaks a walk's probes. That cancels the in-flight claim (if any)
 *   and names the command that took the cursor, so the owner can log it. The
 *   hidden legacy Replay Navigation, Replay Speed and Replay Transport actions
 *   are callers too (#1334): a key placed before Replay Control still runs them.
 *
 * The module also keeps the one **pending landing** (#1230): the frame the last
 * Replay Markers jump was sent to. `ReplayFrameNum` reaches a jump's target only
 * on a later tick, so a second jump arriving first would measure from the old
 * frame and send the same marker again. iRacing has one replay position, so
 * the landing is one value too — every marker jump records it, every Replay
 * Markers surface (keypad and dials) measures from it, and anything else that
 * takes the cursor (a claim, or any one-shot command) clears it, since the
 * replay is no longer headed there. The rule for when a landing still anchors
 * is the marker surfaces' own (`replay-markers-ops.ts`).
 *
 * Beside it sits the last **replay sighting** (#1230): the frame and time of
 * the last tick that read `IsReplayPlaying` true. For roughly 300 ms after
 * every `setPlayPosition` telemetry reads `IsReplayPlaying` false, so the
 * Replay Markers surfaces hold "in a replay" from this sighting through a short
 * grace rather than taking that blip for the car. One value for the same
 * reason the landing is one: there is one replay. The grace rule is
 * `readReplayContext`'s (`replay-markers-ops.ts`). A real exit to live (a
 * `goToEnd` outside a saved replay, from any action) drops the sighting at
 * once through {@link noteReplayGoToEnd}, so no grace follows it.
 *
 * Deliberately in-memory and process-wide: every action runs in one plugin
 * process, and nothing here belongs in persisted settings.
 */

/** What a claimant holds while it drives the cursor. */
export interface ReplayCursorClaim {
  /** Who claimed the cursor, for the log line of whatever takes it. */
  readonly owner: string;
  /** `null` while the claim stands; the name of the command that took the cursor once it did. */
  readonly cancelledBy: string | null;
  /** Hand the cursor back when done. A no-op once the claim has been cancelled or superseded. */
  release(): void;
}

class Claim implements ReplayCursorClaim {
  cancelledBy: string | null = null;

  constructor(
    readonly owner: string,
    private readonly onCancelled: ((by: string) => void) | undefined,
  ) {}

  cancel(by: string): void {
    if (this.cancelledBy !== null) return;

    this.cancelledBy = by;
    this.onCancelled?.(by);
  }

  release(): void {
    if (current === this) current = null;
  }
}

let current: Claim | null = null;

/** Where the last marker jump was sent, and when. */
export interface ReplayLanding {
  readonly frame: number;
  /** `Date.now()` at the send. */
  readonly sentAt: number;
}

let landing: ReplayLanding | null = null;

/** The last tick that read as a replay: the frame on screen, and when. */
export interface ReplaySighting {
  readonly frame: number;
  /** `Date.now()` at the read. */
  readonly seenAt: number;
}

let sighting: ReplaySighting | null = null;

/**
 * Set by a live exit (`noteReplayGoToEnd`) until the first read that has left
 * the replay. iRacing applies the command a tick or two later, so the reads in
 * between still show the old replay position; recording them would revive the
 * frame the exit just dropped.
 */
let liveExitPending = false;

/**
 * Claim the cursor for a long-running driver. An earlier claim still standing
 * is cancelled first, naming the new owner. `onCancelled` runs synchronously,
 * once, when something takes the cursor — the place to log
 * `walk cancelled by <command>` at the moment it happens.
 */
export function claimReplayCursor(owner: string, onCancelled?: (by: string) => void): ReplayCursorClaim {
  landing = null;
  current?.cancel(owner);
  const claim = new Claim(owner, onCancelled);

  current = claim;

  return claim;
}

/**
 * Cancel the in-flight claim, if any, before sending a one-shot cursor command.
 * Returns the cancelled owner's name, or `null` when nothing was in flight.
 * Idempotent: a claim already cancelled is not renamed. Clears the pending
 * landing too, claim or no claim: the command about to be sent moves the replay
 * somewhere else. A marker jump records its own landing after its send.
 */
export function cancelReplayCursorOwner(by: string): string | null {
  landing = null;
  const claim = current;

  if (claim === null) return null;

  const wasStanding = claim.cancelledBy === null;

  claim.cancel(by);
  current = null;

  return wasStanding ? claim.owner : null;
}

/** The owner whose claim currently stands, or `null`. */
export function currentReplayCursorOwner(): string | null {
  return current === null || current.cancelledBy !== null ? null : current.owner;
}

/** Records the frame a marker jump was just sent to. Call it only when the jump was actually sent. */
export function recordReplayLanding(frame: number, sentAt: number): void {
  landing = { frame, sentAt };
}

/** The last marker jump's landing, or `null` once something else took the cursor. Whether it still anchors is the caller's rule. */
export function pendingReplayLanding(): ReplayLanding | null {
  return landing;
}

/** Drops the pending landing: the replay got there, the hold ran out, or there is no replay to land in. */
export function clearReplayLanding(): void {
  landing = null;
}

/** Records a read that showed a replay playing at `frame`. */
export function recordReplaySighting(frame: number, seenAt: number): void {
  if (liveExitPending) return;

  sighting = { frame, seenAt };
}

/** The last read that showed a replay, or `null` since the replay was left (or never seen). */
export function lastReplaySighting(): ReplaySighting | null {
  return sighting;
}

/** Drops the sighting: the replay has been left for the car. */
export function clearReplaySighting(): void {
  sighting = null;
  liveExitPending = false;
}

/**
 * Tells the sighting that a `goToEnd` command was just sent. In a session that
 * can go live, a successful `goToEnd` leaves the replay for the car at once,
 * so the sighting is dropped: a false read straight after it is the car, not
 * the post-seek blip, and holding the old replay frame through the grace would
 * file an Add at that frame instead of the live edge. In a saved replay
 * (`replayOnlySession`, `WeekendInfo.SimMode === "replay"`) the same command
 * only seeks to the end of the file and the replay stays open, so the sighting
 * and its grace stand. A command that was not sent changes nothing. Until the
 * first read that has left the replay, replay reads are not recorded: they are
 * the ticks before iRacing applies the command. Returns whether the sighting
 * was dropped.
 */
export function noteReplayGoToEnd(sent: boolean, replayOnlySession: boolean): boolean {
  if (!sent || replayOnlySession) return false;

  sighting = null;
  liveExitPending = true;

  return true;
}

/** @internal Reset for tests. */
export function _resetReplayCursor(): void {
  current = null;
  landing = null;
  sighting = null;
  liveExitPending = false;
}
