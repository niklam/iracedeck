/**
 * Press sounds (issue #269): a dry click when a press acts as a tap, and a
 * two-note bleep when a hold passes the long-press threshold.
 *
 * One wrapper, {@link withPressSounds}, sits around every registered action
 * handler (applied once in `plugin-runtime`'s `registerActions`) and owns the
 * timing. An action only says what shape its press has, through the optional
 * synchronous {@link IDeckActionHandler.keyPressShape},
 * {@link IDeckActionHandler.dialPressShape} and
 * {@link IDeckActionHandler.touchPressShape} — one per surface, each called by
 * the wrapper path that surface's event arrives on, so an action never has to
 * work out where a press came from; no action plays a sound itself.
 * Spec: docs/superpowers/specs/2026-10-28-issue-269-press-sounds.md.
 *
 * deck-core stays sim-neutral and audio-free: the mode comes from
 * `@iracedeck/settings`, the connection from {@link getSimConnection}, and the
 * sound goes out through the `play` delegate {@link initPressSounds} injects —
 * the same injected-delegate shape as the keyboard and the window focuser.
 *
 * Nothing here may break a press: every read the wrapper makes before calling
 * the handler is guarded and degrades to "no sound", the timer callback and
 * every `play` call catch everything (a throw in a timer callback ends the
 * plugin), and the handler's own result — value, rejection or synchronous
 * throw — reaches the adapter unchanged.
 */
import type { PressSoundMode } from "@iracedeck/app-constants";
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";
import { getGlobalSettings } from "@iracedeck/settings";

import { classifyDialRelease, DIAL_LONG_PRESS_THRESHOLD_MS } from "./dial-gesture.js";
import { getSimConnection } from "./sim-connection.js";
import type { IDeckActionHandler, IDeckEvent, IDeckTouchTapEvent, PressShape } from "./types.js";

/** The two press sounds: the click (`tap`) and the bleep (`long`). */
export type PressSound = "tap" | "long";

/**
 * Plays one press sound. Injected at startup; the player itself (the clips,
 * the channel, the level) lives with the audio code in `iracing-actions`. It
 * must not block: it is called on the press's own synchronous path.
 */
export type PressSoundPlayer = (sound: PressSound) => void;

/** What {@link initPressSounds} takes. */
export interface PressSoundsDeps {
  play: PressSoundPlayer;
  /** Where the wrapper's debug lines go. Defaults to a silent logger. */
  logger?: ILogger;
}

/**
 * The shape a dial press gets when its handler declares none: decided at
 * release, at the default dial threshold, clicking on a short release and never
 * bleeping (nothing is known about its long outcome).
 */
export const DEFAULT_DIAL_PRESS_SHAPE: PressShape = Object.freeze({
  kind: "release",
  thresholdMs: DIAL_LONG_PRESS_THRESHOLD_MS,
  short: true,
  long: false,
});

/** The shape a key press or a touch gets when its handler declares none. */
export const DEFAULT_KEY_PRESS_SHAPE: PressShape = Object.freeze({ kind: "tap" });

/**
 * The longest delay `setTimeout` honours. A larger one (or `Infinity`, which
 * `dialGestureShape` in `iracing-actions` uses for a host whose release is
 * never long) overflows to an immediate fire in Node, so such a threshold arms
 * nothing.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

let player: PressSoundPlayer | null = null;
let logger: ILogger = silentLogger;

/**
 * Install the press sound player. Called once at plugin startup by
 * `plugin-runtime`'s `registerActions`; until it is, every wrapped handler
 * plays nothing and records nothing.
 */
export function initPressSounds(deps: PressSoundsDeps): void {
  if (player) {
    throw new Error("Press sounds already initialized. initPressSounds() should only be called once.");
  }

  player = deps.play;
  logger = deps.logger ?? silentLogger;
}

/**
 * Reset the module to its uninitialized state.
 *
 * @internal Exported for testing
 */
export function _resetPressSounds(): void {
  player = null;
  logger = silentLogger;
}

/**
 * The live press sound mode, from global settings. `GlobalSettingsSchema`
 * guarantees one of the four: its `.default().catch()` turns a missing,
 * hand-edited or future value into `none`, and the cache holds a parsed object
 * from module load on, so there is nothing to re-validate here.
 */
export function getPressSoundMode(): PressSoundMode {
  return getGlobalSettings().pressSound;
}

const playsTaps = (mode: PressSoundMode): boolean => mode === "taps" || mode === "both";
const playsLong = (mode: PressSoundMode): boolean => mode === "long-press" || mode === "both";

/** Which surface a press started on: its up must come from the same one. */
type PressSurface = "key" | "dial";

/** One armed press on one context. */
interface ActivePress {
  readonly surface: PressSurface;
  readonly shape: PressShape;
  /** The mode read at down; a change mid-press does not change this press. */
  readonly mode: PressSoundMode;
  readonly startMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** A pressed rotation happened: push+turn, which is silent at release. */
  rotated: boolean;
}

/**
 * Every member of {@link IDeckActionHandler}, each one required to be present
 * as a key (its value may still be `undefined`). Typing the wrapper with it is
 * what makes a member added to the interface later a compile error here until
 * the wrapper forwards it.
 */
type EveryHandlerMember<H> = { [K in keyof Required<H>]: H[K] | undefined };

/**
 * Wrap an action handler so its presses make the press sounds. Every
 * {@link IDeckActionHandler} member is forwarded to `handler` as a method call
 * (so `this` is the original instance) with the same event and the same
 * result. A member the handler lacks stays `undefined` on the wrapper, except
 * the ones the wrapper needs to end a press (`onKeyUp`, `onDialUp`,
 * `onDialRotate`, `onWillDisappear`, `onDidReceiveSettings`), which forward
 * through optional chaining — the adapters call every member that way.
 *
 * Per context id:
 *
 * - At down the mode and the connection are read once. With the mode `none`,
 *   the sim disconnected or no player installed, nothing is recorded and no
 *   shape member is called. Otherwise the surface's own shape member is asked
 *   (`keyPressShape` on the key path, `dialPressShape` on the dial path), or
 *   that surface's default when the handler lacks it, the handler's own down
 *   member is called, and the down sound plays right after its synchronous
 *   part returns, before its promise is awaited.
 * - A `hold`, or a `release` with a long outcome, arms one timer at
 *   `thresholdMs` that bleeps once if the press is still held.
 * - A pressed rotation disarms it and marks the press push+turn: silent at
 *   release.
 * - At up a `release` press is classified by {@link classifyDialRelease}, the
 *   comparison every dial surface uses (a release exactly at the threshold is
 *   long), and clicks if it was short and `short` is set.
 * - `onWillDisappear` and `onDidReceiveSettings` forget the press and disarm;
 *   a second down replaces a press whose up was lost.
 */
export function withPressSounds<T>(handler: IDeckActionHandler<T>): IDeckActionHandler<T> {
  const presses = new Map<string, ActivePress>();

  const forget = (contextId: string): void => {
    const press = presses.get(contextId);

    if (!press) return;

    if (press.timer !== null) clearTimeout(press.timer);

    presses.delete(contextId);
  };

  /**
   * Everything the wrapper decides at a down event, before the handler runs.
   * Returns the press to finish after the handler's synchronous part, or `null`
   * when this press makes no sound. Never throws.
   */
  const beginPress = (
    ev: IDeckEvent<T>,
    surface: PressSurface,
    declared: (() => PressShape) | undefined,
  ): ActivePress | null => {
    const contextId = ev.action.id;
    forget(contextId);

    const mode = readGate();

    if (mode === null) return null;

    const shape = resolveShape(declared, surface === "key" ? DEFAULT_KEY_PRESS_SHAPE : DEFAULT_DIAL_PRESS_SHAPE);
    const press: ActivePress = { surface, shape, mode, startMs: Date.now(), timer: null, rotated: false };

    const bleepAtThreshold = playsLong(mode) && (shape.kind === "hold" || (shape.kind === "release" && shape.long));

    if (shape.kind === "hold" || shape.kind === "release") {
      if (bleepAtThreshold && isArmableDelay(shape.thresholdMs)) {
        press.timer = setTimeout(
          () => {
            // A throw here would escape the timer callback uncaught and end the
            // plugin process (the reason `createHoldPreview` gives). The press
            // is display-only feedback, so any failure is "no bleep".
            try {
              press.timer = null;

              if (presses.get(contextId) === press && !press.rotated) safePlay("long");
            } catch (err) {
              logger.debug(`Press sound timer failed: ${String(err)}`);
            }
          },
          Math.max(0, shape.thresholdMs),
        );
      }

      presses.set(contextId, press);
    }

    return press;
  };

  /** The down sound, played after the handler's synchronous part. */
  const downSound = (press: ActivePress | null): void => {
    if (!press) return;

    const { shape, mode } = press;

    if ((shape.kind === "tap" || shape.kind === "hold") && playsTaps(mode)) safePlay("tap");
    else if (shape.kind === "long" && playsLong(mode)) safePlay("long");
  };

  /**
   * Everything the wrapper decides at an up event, before the handler runs.
   * Returns the sound to play after its synchronous part, or `null`.
   */
  const endPress = (ev: IDeckEvent<T>, surface: PressSurface): PressSound | null => {
    const contextId = ev.action.id;
    const press = presses.get(contextId);

    if (!press || press.surface !== surface) return null;

    const nowMs = Date.now();
    forget(contextId);

    const { shape, mode } = press;

    if (shape.kind !== "release" || !shape.short || !playsTaps(mode)) return null;

    const kind = classifyDialRelease({
      pressStartMs: press.startMs,
      nowMs,
      rotatedWhilePressed: press.rotated,
      thresholdMs: shape.thresholdMs,
    });

    return kind === "short" ? "tap" : null;
  };

  /**
   * Call a handler member and run `after` (the sound) the moment its
   * synchronous part returns, before its promise is awaited: the sound never
   * waits on the press's awaits, and never delays the press. A synchronous
   * throw skips `after`.
   */
  const callThenPlay = (call: () => Promise<void> | undefined, after: () => void): Promise<void> | undefined => {
    const pending = call();
    after();

    return pending;
  };

  const wrapped: EveryHandlerMember<IDeckActionHandler<T>> = {
    keyPressShape: handler.keyPressShape ? (ev) => handler.keyPressShape!(ev) : undefined,

    dialPressShape: handler.dialPressShape ? (ev) => handler.dialPressShape!(ev) : undefined,

    touchPressShape: handler.touchPressShape ? (ev) => handler.touchPressShape!(ev) : undefined,

    onWillAppear: handler.onWillAppear ? (ev) => handler.onWillAppear!(ev) : undefined,

    async onWillDisappear(ev) {
      forget(ev.action.id);
      await handler.onWillDisappear?.(ev);
    },

    async onDidReceiveSettings(ev) {
      forget(ev.action.id);
      await handler.onDidReceiveSettings?.(ev);
    },

    onKeyDown: handler.onKeyDown
      ? async (ev) => {
          const press = beginPress(ev, "key", handler.keyPressShape ? () => handler.keyPressShape!(ev) : undefined);

          await callThenPlay(
            () => {
              try {
                return handler.onKeyDown!(ev);
              } catch (err) {
                forget(ev.action.id);
                throw err;
              }
            },
            () => downSound(press),
          );
        }
      : undefined,

    async onKeyUp(ev) {
      const sound = endPress(ev, "key");

      await callThenPlay(
        () => handler.onKeyUp?.(ev),
        () => {
          if (sound) safePlay(sound);
        },
      );
    },

    async onDialRotate(ev) {
      if (ev.payload.pressed) {
        const press = presses.get(ev.action.id);

        if (press && press.surface === "dial") {
          press.rotated = true;

          if (press.timer !== null) {
            clearTimeout(press.timer);
            press.timer = null;
          }
        }
      }

      await handler.onDialRotate?.(ev);
    },

    onDialDown: handler.onDialDown
      ? async (ev) => {
          const press = beginPress(ev, "dial", handler.dialPressShape ? () => handler.dialPressShape!(ev) : undefined);

          await callThenPlay(
            () => {
              try {
                return handler.onDialDown!(ev);
              } catch (err) {
                forget(ev.action.id);
                throw err;
              }
            },
            () => downSound(press),
          );
        }
      : undefined,

    async onDialUp(ev) {
      const sound = endPress(ev, "dial");

      await callThenPlay(
        () => handler.onDialUp?.(ev),
        () => {
          if (sound) safePlay(sound);
        },
      );
    },

    onTouchTap: handler.onTouchTap
      ? async (ev) => {
          const sound = touchSound(handler, ev);

          await callThenPlay(
            () => handler.onTouchTap!(ev),
            () => {
              if (sound) safePlay(sound);
            },
          );
        }
      : undefined,
  };

  return wrapped;
}

/**
 * The mode a press gets, or `null` when it makes no sound: no player, the mode
 * `none`, or the sim disconnected. Read once at down. Never throws.
 */
function readGate(): PressSoundMode | null {
  if (!player) return null;

  try {
    const mode = getPressSoundMode();

    if (mode === "none") return null;

    return getSimConnection().isConnected() ? mode : null;
  } catch (err) {
    logger.debug(`Press sound skipped: reading the mode or the connection failed: ${String(err)}`);

    return null;
  }
}

/**
 * The shape the surface's member declares (`declared` calls it with the
 * event, `this` intact), the surface's default when the handler lacks it, or
 * `none` when it throws.
 */
function resolveShape(declared: (() => PressShape) | undefined, fallback: PressShape): PressShape {
  if (!declared) return fallback;

  try {
    return declared() ?? fallback;
  } catch (err) {
    logger.debug(`A press shape member threw; this press makes no sound: ${String(err)}`);

    return { kind: "none" };
  }
}

/**
 * The sound a touch makes, from the handler's `touchPressShape` (a `tap` when
 * it has none). A touch is complete when it arrives (the host reports a long
 * touch as `hold`), so there is no timer and no up: `tap` and
 * `hold` click, `long` bleeps, and `release` reads the event's own `hold` flag
 * as the release classification.
 */
function touchSound<T>(handler: IDeckActionHandler<T>, ev: IDeckTouchTapEvent<T>): PressSound | null {
  const mode = readGate();

  if (mode === null) return null;

  const shape = resolveShape(
    handler.touchPressShape ? () => handler.touchPressShape!(ev) : undefined,
    DEFAULT_KEY_PRESS_SHAPE,
  );

  switch (shape.kind) {
    case "tap":
    case "hold":
      return playsTaps(mode) ? "tap" : null;
    case "long":
      return playsLong(mode) ? "long" : null;
    case "release":
      if (ev.payload.hold) return shape.long && playsLong(mode) ? "long" : null;

      return shape.short && playsTaps(mode) ? "tap" : null;
    case "none":
      return null;
  }
}

function isArmableDelay(ms: number): boolean {
  return Number.isFinite(ms) && ms <= MAX_TIMER_DELAY_MS;
}

/** Play through the injected player; a throw or a rejection never escapes. */
function safePlay(sound: PressSound): void {
  const play = player;

  if (!play) return;

  try {
    const result: unknown = play(sound);

    if (result instanceof Promise) {
      result.catch((err: unknown) => logger.debug(`Press sound "${sound}" failed: ${String(err)}`));
    }
  } catch (err) {
    logger.debug(`Press sound "${sound}" failed: ${String(err)}`);
  }
}
