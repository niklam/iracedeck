/**
 * Per-context throttle + trailing-edge coalescer for Stream Deck icon
 * updates (issue #493).
 *
 * Built for actions that subscribe directly to the SDK at 60 Hz and re-render
 * their key image when a derived state changes. Without a throttle, a
 * fast-moving telemetry value (RPM, speed) would fire 60 `setKeyImage`
 * calls per second per key — risks USB / WebSocket saturation and visible
 * hitching, even though the device cannot meaningfully display 60 frames
 * per second on a single key.
 *
 * Behavior per context id:
 *   - First call OR call >= `windowMs` since the last send: render
 *     immediately, record the send time, cancel any pending flush.
 *   - Call inside the window: if no flush is pending, arm one timer for
 *     the moment the window expires; if one is pending, only replace the
 *     render it will run. The newest render always wins, and re-rendering at
 *     flush time means the *latest* state always wins; we never need to
 *     remember intermediate values.
 *
 * The timer is armed once per window rather than re-armed per call (#1339):
 * its deadline is anchored to the last send, which does not move while a
 * flush is pending, so a re-armed timer would fire at the same moment and
 * cost a clearTimeout, a setTimeout and a closure per tick per key.
 *
 * The render closure is re-evaluated at every call (immediate or trailing),
 * so callers can pass a closure that resolves from current state — no need
 * to capture and update an intermediate "pending state".
 */
/** A trailing flush armed for one context: its timer and the render it runs. */
interface PendingFlush {
  readonly timer: ReturnType<typeof setTimeout>;
  render: () => Promise<void> | void;
}

export class IconUpdateThrottle {
  /** @internal Exposed so tests can inspect throttle state. */
  readonly lastImageSentAt = new Map<string, number>();
  /**
   * @internal Exposed so tests can inspect pending flushes: the one timer
   * armed for the window, and the newest render it will run.
   */
  readonly pendingFlush = new Map<string, PendingFlush>();

  /** Minimum gap between sends for the same context (default 100 ms — 10 Hz). */
  constructor(private readonly windowMs = 100) {}

  /**
   * Either render immediately or coalesce into a trailing flush.
   *
   * `render` errors — synchronous throws and async rejections alike — are
   * swallowed (logged via the host's normal logger if the action wraps the
   * call); the throttle stays in a clean state so the next change still
   * gets through.
   */
  schedule(contextId: string, render: () => Promise<void> | void): void {
    const now = Date.now();
    const last = this.lastImageSentAt.get(contextId) ?? 0;
    const elapsed = now - last;

    if (elapsed >= this.windowMs) {
      // Outside the window — fire immediately. Drop any pending flush
      // because this immediate render supersedes it.
      this.lastImageSentAt.set(contextId, now);
      this.cancelPending(contextId);
      IconUpdateThrottle.invokeRender(render);

      return;
    }

    // Inside the window — coalesce. A flush already pending fires at the
    // window's end, which is anchored to the last send and so has not moved:
    // hand it the newest render and leave its timer alone.
    const pending = this.pendingFlush.get(contextId);

    if (pending) {
      pending.render = render;

      return;
    }

    const flush: PendingFlush = {
      render,
      timer: setTimeout(() => {
        this.pendingFlush.delete(contextId);
        this.lastImageSentAt.set(contextId, Date.now());
        IconUpdateThrottle.invokeRender(flush.render);
      }, this.windowMs - elapsed),
    };

    this.pendingFlush.set(contextId, flush);
  }

  /**
   * Run `render` synchronously, swallowing synchronous throws and async
   * rejections alike — an escaping throw would propagate into the caller's
   * telemetry fan-out (immediate branch) or become an unhandled error in
   * the timer callback (trailing branch).
   */
  private static invokeRender(render: () => Promise<void> | void): void {
    try {
      void Promise.resolve(render()).catch(() => {});
    } catch {
      // Synchronous throw — swallowed, same contract as async rejections.
    }
  }

  /**
   * Cancel any pending flush and forget the context. Call from
   * `onWillDisappear` (and any teardown that drops the context) so timers
   * never fire after the action is gone.
   */
  clear(contextId: string): void {
    this.cancelPending(contextId);
    this.lastImageSentAt.delete(contextId);
  }

  /** Cancel everything. */
  clearAll(): void {
    for (const id of [...this.pendingFlush.keys()]) {
      this.cancelPending(id);
    }

    this.lastImageSentAt.clear();
  }

  private cancelPending(contextId: string): void {
    const pending = this.pendingFlush.get(contextId);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingFlush.delete(contextId);
    }
  }
}
