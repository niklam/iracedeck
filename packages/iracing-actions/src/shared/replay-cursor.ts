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
 * - A long-running driver **claims** the cursor for the duration and checks
 *   `cancelledBy` at every await — a non-null value means "stop, send nothing
 *   more". The walk is one; so is every jump that waits for its landing
 *   (`replay-jump-playback.ts`, #1276): Jump to Fastest Lap's record jump and
 *   Replay Markers' Next / Previous. A new claim cancels the one standing, so a
 *   second jump takes over from the first.
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
 * And the one **pending jump speed** (#1276): the speed the replay had before
 * a jump that is still under way, or the speed a finished jump left it at until
 * telemetry shows it. A jump pauses a moving replay before it seeks, so a
 * second jump pressed meanwhile would read "paused" and remember that instead
 * of the speed the driver chose. Like the landing it is one value, cleared by
 * anything else that takes the cursor: a speed or pause command from any key
 * is the driver's new choice. The rule for when it still stands is the jump
 * sequence's own (`replay-jump-playback.ts`).
 *
 * Whether a replay is on screen is not kept here: the debounced replay state
 * (#1324), which holds "in a replay" through the ~300 ms post-seek blip and
 * drops at once on the plugin's own `goToEnd` to live, lives on
 * `SDKController` (`getReplayState()` / `noteReplayLeftForLive()`), the one
 * instance every replay consumer reads.
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

/** The speed a jump found, or left, in the units `setPlaySpeed` takes. */
export interface ReplayJumpSpeed {
  readonly speed: number;
  readonly slowMotion: boolean;
  /** `null` while the jump that captured the speed is still under way; `Date.now()` at the moment a jump applied it. */
  readonly appliedAt: number | null;
}

let jumpSpeed: ReplayJumpSpeed | null = null;

/**
 * Claim the cursor for a long-running driver. An earlier claim still standing
 * is cancelled first, naming the new owner. `onCancelled` runs synchronously,
 * once, when something takes the cursor — the place to log
 * `walk cancelled by <command>` at the moment it happens.
 */
export function claimReplayCursor(owner: string, onCancelled?: (by: string) => void): ReplayCursorClaim {
  landing = null;
  jumpSpeed = null;
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
 * somewhere else. The pending jump speed goes with it: the command is the driver's own choice of
 * what the replay does next.
 */
export function cancelReplayCursorOwner(by: string): string | null {
  landing = null;
  jumpSpeed = null;
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

/** Records the frame a marker jump is headed for. Call it after the jump has claimed the cursor, since the claim clears it. */
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

/** Records the speed a jump captured (`appliedAt` null) or applied (`appliedAt` the moment it did). */
export function recordReplayJumpSpeed(speed: ReplayJumpSpeed): void {
  jumpSpeed = speed;
}

/** The pending jump speed, or `null` once something else took the cursor. Whether it still stands is the caller's rule. */
export function pendingReplayJumpSpeed(): ReplayJumpSpeed | null {
  return jumpSpeed;
}

/** Drops the pending jump speed: telemetry shows it, the hold ran out, or the jump that captured it gave up. */
export function clearReplayJumpSpeed(): void {
  jumpSpeed = null;
}

/** @internal Reset for tests. */
export function _resetReplayCursor(): void {
  current = null;
  landing = null;
  jumpSpeed = null;
}
