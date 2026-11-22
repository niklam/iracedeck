/**
 * Per-key window focus (issue #1654): the wrapper that gives every action its
 * own **Focus iRacing window** choice.
 *
 * {@link withWindowFocus} sits around every registered action handler, outside
 * the press-sound wrapper (`withWindowFocus(withPressSounds(handler))`, applied
 * once in `plugin-runtime`'s `registerActions`). It replaces the adapter-level
 * focus listeners the plugins used to register, because those could not see
 * which key was pressed. It must stay outside: the press-time focus is
 * synchronous and can block for up to a second on a timeout, and the
 * press-sound wrapper stamps a press's start and arms its long-press timer
 * before it calls the handler, so a focus inside it would count against the
 * dial long-press threshold and turn a tap into a long press. At a press it
 * reads the key's `windowFocus` from the event's settings and does two things:
 *
 * - **Keystroke time.** It runs every press member — down, up, rotate and
 *   touch — inside the focus service's async scope, so the keystrokes the
 *   handler sends, however deep and however late, are focused as the key's
 *   setting says.
 * - **Press time.** Inside that scope, before a key down, dial down or dial
 *   rotation reaches the handler, it asks for focus as the key's setting says
 *   (`focusIRacingForPress` in the focus service). Asking inside the scope is
 *   what lets the press-time ask and the keystrokes share the scope's
 *   once-per-call flags, so each per-key debug line goes out at most once per
 *   handler call. A touch-strip tap never focuses at press time (#978).
 *
 * Nothing here may break a press: the settings read never throws (an
 * unreadable value is `global`), a press-time focus failure is logged and
 * swallowed, and the handler's own result — value, rejection or synchronous
 * throw — reaches the caller unchanged. Spec:
 * docs/superpowers/specs/2026-11-08-issue-1654-per-key-window-focus.md.
 */
import { type WindowFocusOverride, WindowFocusOverrideSchema } from "./common-settings.js";
import type { IDeckActionHandler } from "./types.js";
import { focusIRacingForPress, runInWindowFocusScope } from "./window-focus-service.js";

/**
 * Every member of {@link IDeckActionHandler}, each one required to be present
 * as a key (its value may still be `undefined`). Typing the wrapper with it is
 * what makes a member added to the interface later a compile error here until
 * the wrapper forwards it — the same device `withPressSounds` uses.
 */
type EveryHandlerMember<H> = { [K in keyof Required<H>]: H[K] | undefined };

/**
 * The key's own `windowFocus` value, read from an event's raw settings through
 * the field's schema. Anything it cannot read — no settings, a non-object, a
 * value from a newer build, a getter that throws — is `global`. Never throws.
 */
export function readWindowFocusOverride(settings: unknown): WindowFocusOverride {
  try {
    if (typeof settings !== "object" || settings === null) return "global";

    return WindowFocusOverrideSchema.parse((settings as Record<string, unknown>).windowFocus);
  } catch {
    return "global";
  }
}

/**
 * The press-time ask, guarded: a focus problem must never stop the handler
 * the user pressed the key for. The service logs its own failures and
 * swallows the focuser's; this catches what is left (a settings read or a
 * logger that throws).
 */
function focusAtPress(override: WindowFocusOverride): void {
  try {
    focusIRacingForPress(override);
  } catch {
    // Best-effort by contract. There is nothing reliable left to log with.
  }
}

/**
 * Wrap an action handler so its presses follow the key's own `windowFocus`
 * setting. Every {@link IDeckActionHandler} member is forwarded to `handler`
 * as a method call (so `this` is the original instance) with the same event
 * and the same result, and a member the handler lacks stays `undefined`, so
 * this wrapper exposes exactly the members the handler it wraps has.
 *
 * - `onKeyDown`, `onDialDown`, `onDialRotate`: inside the key's scope, the
 *   press-time focus and then the handler.
 * - `onKeyUp`, `onDialUp`: the handler inside the key's scope, no focus.
 * - `onTouchTap`: the handler inside the key's scope, no press-time focus.
 * - Everything else: forwarded unchanged, outside any scope.
 *
 * The value is read per event, from the settings that event carries, so a
 * change in the Property Inspector applies from the next press.
 */
export function withWindowFocus<T>(handler: IDeckActionHandler<T>): IDeckActionHandler<T> {
  const wrapped: EveryHandlerMember<IDeckActionHandler<T>> = {
    keyPressShape: handler.keyPressShape ? (ev) => handler.keyPressShape!(ev) : undefined,

    dialPressShape: handler.dialPressShape ? (ev) => handler.dialPressShape!(ev) : undefined,

    touchPressShape: handler.touchPressShape ? (ev) => handler.touchPressShape!(ev) : undefined,

    onWillAppear: handler.onWillAppear ? (ev) => handler.onWillAppear!(ev) : undefined,

    onWillDisappear: handler.onWillDisappear ? (ev) => handler.onWillDisappear!(ev) : undefined,

    onDidReceiveSettings: handler.onDidReceiveSettings ? (ev) => handler.onDidReceiveSettings!(ev) : undefined,

    onKeyDown: handler.onKeyDown
      ? (ev) => {
          const override = readWindowFocusOverride(ev.payload.settings);

          return runInWindowFocusScope(override, () => {
            focusAtPress(override);

            return handler.onKeyDown!(ev);
          });
        }
      : undefined,

    onKeyUp: handler.onKeyUp
      ? (ev) => runInWindowFocusScope(readWindowFocusOverride(ev.payload.settings), () => handler.onKeyUp!(ev))
      : undefined,

    onDialDown: handler.onDialDown
      ? (ev) => {
          const override = readWindowFocusOverride(ev.payload.settings);

          return runInWindowFocusScope(override, () => {
            focusAtPress(override);

            return handler.onDialDown!(ev);
          });
        }
      : undefined,

    onDialUp: handler.onDialUp
      ? (ev) => runInWindowFocusScope(readWindowFocusOverride(ev.payload.settings), () => handler.onDialUp!(ev))
      : undefined,

    onDialRotate: handler.onDialRotate
      ? (ev) => {
          const override = readWindowFocusOverride(ev.payload.settings);

          return runInWindowFocusScope(override, () => {
            focusAtPress(override);

            return handler.onDialRotate!(ev);
          });
        }
      : undefined,

    onTouchTap: handler.onTouchTap
      ? (ev) => runInWindowFocusScope(readWindowFocusOverride(ev.payload.settings), () => handler.onTouchTap!(ev))
      : undefined,
  };

  return wrapped;
}
