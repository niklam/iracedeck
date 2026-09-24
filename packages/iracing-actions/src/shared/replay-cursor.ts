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
 * - Any one-shot jump, in ANY action, calls {@link cancelReplayCursorOwner}
 *   before sending its command. That cancels the in-flight claim (if any) and
 *   names the command that took the cursor, so the owner can log it.
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

/**
 * Claim the cursor for a long-running driver. An earlier claim still standing
 * is cancelled first, naming the new owner. `onCancelled` runs synchronously,
 * once, when something takes the cursor — the place to log
 * `walk cancelled by <command>` at the moment it happens.
 */
export function claimReplayCursor(owner: string, onCancelled?: (by: string) => void): ReplayCursorClaim {
  current?.cancel(owner);
  const claim = new Claim(owner, onCancelled);

  current = claim;

  return claim;
}

/**
 * Cancel the in-flight claim, if any, before sending a one-shot cursor command.
 * Returns the cancelled owner's name, or `null` when nothing was in flight.
 * Idempotent: a claim already cancelled is not renamed.
 */
export function cancelReplayCursorOwner(by: string): string | null {
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

/** @internal Reset for tests. */
export function _resetReplayCursor(): void {
  current = null;
}
