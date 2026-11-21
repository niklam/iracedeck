import type { ILogger } from "@iracedeck/logger";

/**
 * Options for a single long-press hold registered with {@link RepeatController}.
 */
export interface RepeatOptions {
  /** Delay before the repeat loop starts. Quick taps shorter than this never repeat. */
  holdMs: number;
  /** Delay between repeat ticks once the loop is running. */
  intervalMs: number;
  /** Hard cap for the entire hold — catches dropped keyUp events. */
  safetyMs: number;
  /**
   * Per-tick work. Return `false` to stop the loop (e.g. settings went stale).
   * May be async; the loop awaits it before scheduling the next tick, so there
   * is at most one in-flight execution per button.
   */
  execute: () => Promise<boolean> | boolean;
}

export interface RepeatEntry {
  hold?: ReturnType<typeof setTimeout>;
  next?: ReturnType<typeof setTimeout>;
  safety: ReturnType<typeof setTimeout>;
  options: RepeatOptions;
  /**
   * Settles once every first press handed to {@link RepeatController.runFirstPress}
   * for this hold has settled, whether it resolved or threw (#1693).
   */
  firstPress?: Promise<void>;
  /** Whether {@link firstPress} is still pending. */
  firstPressPending?: boolean;
}

const noop = (): void => {};

/**
 * Shared long-press repeat state machine.
 *
 * Owns `heldButtons` and per-button `hold`/`next`/`safety` timers, and runs a
 * self-awaiting repeat loop that fires `options.execute` at most once at a
 * time. Releasing the button (onKeyUp/clear/clearAll) stops the loop promptly
 * even when an execute is in flight, and a safety timeout guarantees the loop
 * cannot outlive `options.safetyMs` if the keyUp is ever lost.
 *
 * The press a hold starts with goes through {@link runFirstPress}, so the
 * first repeat waits for it too (#1693): a SimHub tap is two HTTP requests, and
 * a repeat that started while a stalled first tap was still between them merged
 * into it, so the driver got one long press instead of a press and a repeat.
 */
export class RepeatController {
  /** @internal Exposed for action classes and test compat. */
  readonly heldButtons = new Set<string>();
  /** @internal Exposed for action classes and test compat. */
  readonly timers = new Map<string, RepeatEntry>();

  constructor(private readonly logger: ILogger) {}

  /**
   * Register a button as held and arm the hold/safety timers.
   *
   * Call this synchronously from the action's `onKeyDown` — before any await —
   * so a racing `onKeyUp` during an async first execute is guaranteed to find
   * the timers and clear them.
   */
  onKeyDown(buttonId: string, options: RepeatOptions): void {
    // Reset any previous state for this button before installing new timers.
    this.clearTimers(buttonId);
    this.heldButtons.add(buttonId);

    // Safety timeout covers the entire hold — dropped keyUp can't leak past this.
    const safety = setTimeout(() => {
      this.logger.warn(`Repeat auto-stopped after ${options.safetyMs}ms (safety timeout — possible missed keyUp)`);
      this.heldButtons.delete(buttonId);
      this.clearTimers(buttonId);
    }, options.safetyMs);

    // Quick taps must never enter the repeat loop: wait holdMs before the first
    // repeat. If keyUp arrives first, clearTimers clears the hold and nothing ever
    // starts.
    const hold = setTimeout(() => {
      const entry = this.timers.get(buttonId);

      if (!entry) return;

      // Double-check: the button may have been released while the hold timer was pending.
      if (!this.heldButtons.has(buttonId)) {
        this.clearTimers(buttonId);

        return;
      }

      entry.hold = undefined;

      // The first press is still in flight (a stalled SimHub tap): the first
      // repeat waits for it, then follows it `intervalMs` later, the spacing the
      // loop keeps between its own ticks. Once it has settled, as it has on the
      // normal fast path, the tick is scheduled at once, as before.
      if (entry.firstPressPending && entry.firstPress) {
        this.logger.debug("First repeat waits for the first press to finish");
        void entry.firstPress.then(() => {
          // A new onKeyDown, a release or the safety timeout may have replaced
          // or cleared the entry while the first press was in flight.
          if (this.timers.get(buttonId) !== entry) return;

          this.scheduleRepeatTick(buttonId);
        });

        return;
      }

      this.scheduleRepeatTick(buttonId);
    }, options.holdMs);

    this.timers.set(buttonId, { hold, safety, options });
  }

  /**
   * Run the press a hold starts with, and make the hold's repeat loop wait for
   * it (#1693). Call it right after {@link onKeyDown}, with nothing awaited in
   * between, for everything the key does before its first repeat may start: the
   * first execute, and a black box shown ahead of it.
   *
   * `press` starts synchronously, and the result is its own, so a caller awaits
   * it and reads it as before. When the hold timer fires while the press is
   * still in flight, the first repeat is scheduled once it settles, whether it
   * resolved or threw. With no hold armed for the button (a key that does not
   * repeat) it only runs `press`.
   */
  runFirstPress<T>(buttonId: string, press: () => Promise<T> | T): Promise<T> {
    const entry = this.timers.get(buttonId);
    const result = (async () => press())();

    if (entry) {
      const settled = result.then(noop, noop);
      const all = entry.firstPress ? Promise.all([entry.firstPress, settled]).then(noop) : settled;

      entry.firstPress = all;
      entry.firstPressPending = true;
      void all.then(() => {
        if (entry.firstPress === all) entry.firstPressPending = false;
      });
    }

    return result;
  }

  /** Mark the button released and clear all of its timers. */
  onKeyUp(buttonId: string): void {
    // Delete from heldButtons BEFORE clearing timers so any in-flight timer
    // callback that re-checks `heldButtons` sees the released state.
    this.heldButtons.delete(buttonId);
    this.clearTimers(buttonId);
  }

  /**
   * Clear a button's state without distinguishing it from a normal release.
   * Used for `onWillDisappear` and `onDidReceiveSettings`.
   */
  clear(buttonId: string): void {
    this.heldButtons.delete(buttonId);
    this.clearTimers(buttonId);
  }

  /** Clear every known button. Used during teardown. */
  clearAll(): void {
    this.heldButtons.clear();

    for (const buttonId of [...this.timers.keys()]) {
      this.clearTimers(buttonId);
    }
  }

  /** Whether the given button is currently held. */
  isHeld(buttonId: string): boolean {
    return this.heldButtons.has(buttonId);
  }

  /**
   * Self-awaiting repeat loop. Each tick fires one execute, awaits it, then
   * schedules the next tick `intervalMs` later. Because we never have more
   * than one in-flight execution per button, releasing mid-hold stops the
   * repeat immediately — there is no queued backlog to drain.
   *
   * The held check runs four times per tick: before scheduling, inside the
   * scheduled callback, after execute resolves, and again before the next
   * schedule. Any of them can abort the loop without leaving orphan timers.
   *
   * Ownership: the scheduled callback closes over the entry object it was
   * armed for. If an overlapping onKeyDown replaces that entry mid-await,
   * the stale callback must not touch `this.timers` or recurse — otherwise
   * it would install an orphan tick on top of the new entry's hold-driven
   * loop and produce two overlapping streams of executes.
   */
  private scheduleRepeatTick(buttonId: string): void {
    if (!this.heldButtons.has(buttonId)) {
      this.clearTimers(buttonId);

      return;
    }

    const entry = this.timers.get(buttonId);

    if (!entry) return;

    entry.next = setTimeout(async () => {
      // Ownership check: a new onKeyDown may have replaced this entry before
      // the setTimeout fired. If so, the new entry owns the loop now — bail.
      if (this.timers.get(buttonId) !== entry) return;

      if (!this.heldButtons.has(buttonId)) {
        this.clearTimers(buttonId);

        return;
      }

      // Intentional: on exception keepGoing stays true so a transient failure
      // does not kill the repeat loop. The safety timeout caps how long a
      // broken execute can spam errors (at most safetyMs / intervalMs attempts).
      let keepGoing = true;

      try {
        keepGoing = (await entry.options.execute()) !== false;
      } catch (err) {
        this.logger.error(`Repeat execution failed: ${String(err)}`);
      }

      // Ownership check after the await: an overlapping onKeyDown may have
      // replaced the entry while execute was in flight. The new entry's own
      // hold timer will drive its loop — do not touch anything here.
      if (this.timers.get(buttonId) !== entry) return;

      if (!keepGoing) {
        this.heldButtons.delete(buttonId);
        this.clearTimers(buttonId);

        return;
      }

      // The button may have been released while execute was in flight.
      if (!this.heldButtons.has(buttonId)) {
        this.clearTimers(buttonId);

        return;
      }

      this.scheduleRepeatTick(buttonId);
    }, entry.options.intervalMs);
  }

  private clearTimers(buttonId: string): void {
    const entry = this.timers.get(buttonId);

    if (entry) {
      if (entry.hold) clearTimeout(entry.hold);

      if (entry.next) clearTimeout(entry.next);

      clearTimeout(entry.safety);
      this.timers.delete(buttonId);
    }
  }
}
