/**
 * The engine's once-per warnings (issue #1514): five keyspaces, each a set of
 * the keys already warned about, so a broken pack is named once per thing
 * that is broken rather than once per fire. Every keyspace is cleared by
 * `setScripts` through `reset()`: a new script map is a new state of affairs
 * — a rescan, a Rescan press, a pack installed — and a pack that is still
 * broken should say so again on that run rather than only on the first.
 * Within a script map each warns once.
 *
 * The keys are the caller's, spelled as they always were, and two callers
 * share one on purpose: the compile-time cut warning and the runtime cut-tail
 * warning both use `<voice>|<frame>|cut` in `frameAborts`, so only one of
 * them is ever said for a frame.
 */

/** The five keyspaces, and what each one's keys name. */
export type OnceWarningKeyspace =
  /**
   * Non-deliberate skips already warned about, keyed `voice|id|reason`, so a
   * dirty recompile only warns about what is new rather than repeating the
   * load's diagnostics on the first fire.
   */
  | "skips"
  /**
   * `(voice, fragment)` pairs whose fragment nothing includes and which did
   * not compile (the compiler's `fragmentProblems`) — warned once each, keyed
   * `voice|name|reason` like the skips. An included fragment's problem is
   * the including entry's skip, reported there.
   */
  | "fragments"
  /** `(case, key)` pairs a resolver returned without declaring — a code bug, warned once each. */
  | "caseKeys"
  /** `(voice, frame)` pairs a legacy scenario asked for that the voice's script does not provide — warned once each. */
  | "legacyFrames"
  /**
   * `(voice, frame)` pairs whose frame aborted a callout (a step resolving to
   * nothing, #835) — warned once each. Per-fire detail stays at debug: a
   * broken frame takes EVERY framed callout of its voice down, and a warn
   * per fire would be a warn per flag.
   */
  | "frameAborts";

export class OnceWarnings {
  private readonly said: Record<OnceWarningKeyspace, Set<string>> = {
    skips: new Set(),
    fragments: new Set(),
    caseKeys: new Set(),
    legacyFrames: new Set(),
    frameAborts: new Set(),
  };

  /**
   * Whether `key` is new to `space` — `true` the first time it is asked, and
   * the key is recorded so every later ask is `false`. The caller warns iff
   * this returns `true`.
   */
  once(space: OnceWarningKeyspace, key: string): boolean {
    const set = this.said[space];

    if (set.has(key)) return false;

    set.add(key);

    return true;
  }

  /** Forget every key of every keyspace (see the module header). */
  reset(): void {
    for (const set of Object.values(this.said)) set.clear();
  }
}
