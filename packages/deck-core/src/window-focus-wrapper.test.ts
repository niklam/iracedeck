import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetBindingDispatcher, getBindingDispatcher, initializeBindingDispatcher } from "./binding-dispatcher.js";
import { createFakeSimConnection } from "./fake-sim-connection.test-support.js";
import { _resetKeyboard, getKeyboard, initializeKeyboard } from "./keyboard-service.js";
import { _resetPressSounds, initPressSounds, withPressSounds } from "./press-sounds.js";
import { _resetSimConnection, initializeSimConnection } from "./sim-connection.js";
import type {
  IDeckActionContext,
  IDeckActionHandler,
  IDeckDialRotateEvent,
  IDeckEvent,
  IDeckTouchTapEvent,
  PressShape,
} from "./types.js";
import {
  _resetWindowFocus,
  FOCUS_TIMEOUT_COOLDOWN_MS,
  focusIRacingBeforeInput,
  FocusResult,
  getWindowFocusScope,
  initWindowFocus,
} from "./window-focus-service.js";
import { readWindowFocusOverride, withWindowFocus } from "./window-focus-wrapper.js";

/**
 * The global settings every service here reads, the real ones under test: the
 * focus mode, the store-ready gate, the press sound mode and one keyboard
 * binding for the dispatcher. `throwOnRead` makes the read throw, the way a
 * broken cache would.
 */
const { state } = vi.hoisted(() => ({
  state: {
    settings: {} as Record<string, unknown>,
    storeReady: true,
    throwOnRead: false,
    focusResult: 0 as number,
    elevationMismatch: false,
  },
}));

vi.mock("@iracedeck/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/settings")>()),
  getGlobalSettings: () => {
    if (state.throwOnRead) throw new Error("settings cache unreadable");

    return state.settings;
  },
  isSettingsStoreReady: () => state.storeReady,
}));

const MODES = ["always", "required", "never"] as const;
const OVERRIDES = ["global", "focus", "no-focus"] as const;

type Mode = (typeof MODES)[number];
type Override = (typeof OVERRIDES)[number];

/** Everything that happened, in order: `focus`, `handler:<member>`, `send:<code>`, `sound:<kind>`. */
const log: string[] = [];

const BINDING_KEY = "testBinding";

function setMode(mode: Mode): void {
  state.settings = {
    focusIRacingWindow: mode,
    pressSound: "both",
    [BINDING_KEY]: JSON.stringify({ key: "f1", modifiers: [], code: "F1" }),
  };
}

function createLogger(): ILogger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ILogger;
}

/** Wire the real window focus service, keyboard and binding dispatcher to recorders. */
function arrange(logger: ILogger = createLogger()): ILogger {
  initWindowFocus(
    logger,
    () => {
      log.push("focus");

      return state.focusResult as FocusResult;
    },
    () => false,
    () => state.elevationMismatch,
  );
  initializeKeyboard(
    createLogger(),
    (codes) => log.push(`send:${codes.join(",")}`),
    (codes) => log.push(`press:${codes.join(",")}`),
    (codes) => log.push(`release:${codes.join(",")}`),
    (chords) => log.push(`sequence:${chords.length}`),
  );
  initializeBindingDispatcher(createLogger());

  return logger;
}

/** Only the sends and the focuses, the part of the log the scope decides. */
const keystrokeLog = (): string[] => log.filter((entry) => entry === "focus" || entry.startsWith("send:"));

const context = (id: string): IDeckActionContext => ({ id }) as IDeckActionContext;

/** Raw settings as the host hands them over: `undefined` stores no `windowFocus` at all. */
const settingsWith = (windowFocus: unknown): Record<string, unknown> =>
  windowFocus === undefined ? {} : { windowFocus };

const ev = (windowFocus?: unknown, id = "ctx-1"): IDeckEvent<unknown> => ({
  action: context(id),
  payload: { settings: settingsWith(windowFocus) },
});

const rotateEv = (windowFocus?: unknown, pressed = false, id = "ctx-1"): IDeckDialRotateEvent<unknown> => ({
  action: context(id),
  payload: { settings: settingsWith(windowFocus), ticks: 1, pressed },
});

const touchEv = (windowFocus?: unknown, id = "ctx-1"): IDeckTouchTapEvent<unknown> => ({
  action: context(id),
  payload: { settings: settingsWith(windowFocus), tapPos: [0, 0], hold: false },
});

type PressMember = "onKeyDown" | "onKeyUp" | "onDialDown" | "onDialUp" | "onDialRotate" | "onTouchTap";

/** A handler whose every press member records itself and runs `body`, if given. */
function recordingHandler(body?: (member: PressMember) => Promise<void> | void): IDeckActionHandler<unknown> {
  const member = (name: PressMember) => async (): Promise<void> => {
    log.push(`handler:${name}`);
    await body?.(name);
  };

  return {
    onKeyDown: member("onKeyDown"),
    onKeyUp: member("onKeyUp"),
    onDialDown: member("onDialDown"),
    onDialUp: member("onDialUp"),
    onDialRotate: member("onDialRotate"),
    onTouchTap: member("onTouchTap"),
  };
}

/** Call one press member of `wrapped` with an event carrying `windowFocus`. */
function press(wrapped: IDeckActionHandler<unknown>, member: PressMember, windowFocus?: unknown, id?: string) {
  switch (member) {
    case "onDialRotate":
      return wrapped.onDialRotate!(rotateEv(windowFocus, false, id));
    case "onTouchTap":
      return wrapped.onTouchTap!(touchEv(windowFocus, id));
    default:
      return wrapped[member]!(ev(windowFocus, id));
  }
}

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

function resetAll(): void {
  _resetWindowFocus();
  _resetKeyboard();
  _resetBindingDispatcher();
  _resetPressSounds();
  _resetSimConnection();
}

describe("withWindowFocus (issue #1654)", () => {
  beforeEach(() => {
    resetAll();
    log.length = 0;
    setMode("always");
    state.storeReady = true;
    state.throwOnRead = false;
    state.focusResult = FocusResult.AlreadyFocused;
    state.elevationMismatch = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAll();
  });

  describe("press-time focus", () => {
    /** Press-time focuses: global follows the mode's `always`, focus always asks, no-focus never does. */
    const expectedPressFocus = (override: Override, mode: Mode): number =>
      override === "focus" || (override === "global" && mode === "always") ? 1 : 0;

    const focusingCases = (["onKeyDown", "onDialDown", "onDialRotate"] as const).flatMap((member) =>
      OVERRIDES.flatMap((override) => MODES.map((mode) => [member, override, mode] as const)),
    );

    it.each(focusingCases)(
      "%s on a %s key under %s focuses as the key says, then calls the handler once",
      async (member, override, mode) => {
        setMode(mode);
        arrange();
        const wrapped = withWindowFocus(recordingHandler());

        await press(wrapped, member, override);

        expect(log).toEqual([...Array(expectedPressFocus(override, mode)).fill("focus"), `handler:${member}`]);
      },
    );

    const quietCases = (["onKeyUp", "onDialUp", "onTouchTap"] as const).flatMap((member) =>
      OVERRIDES.flatMap((override) => MODES.map((mode) => [member, override, mode] as const)),
    );

    it.each(quietCases)("%s on a %s key under %s never focuses at press time", async (member, override, mode) => {
      setMode(mode);
      arrange();
      const wrapped = withWindowFocus(recordingHandler());

      await press(wrapped, member, override);

      expect(log).toEqual([`handler:${member}`]);
    });

    it("reads a key saved before the setting as global", async () => {
      arrange();
      const wrapped = withWindowFocus(recordingHandler());

      await press(wrapped, "onKeyDown");
      setMode("never");
      await press(wrapped, "onKeyDown");

      expect(log).toEqual(["focus", "handler:onKeyDown", "handler:onKeyDown"]);
    });

    it.each([
      ["a value from a newer build", "when-required"],
      ["junk", 42],
      ["null", null],
    ])("reads %s as global", async (_label, value) => {
      arrange();
      const wrapped = withWindowFocus(recordingHandler());

      await press(wrapped, "onKeyDown", value);

      expect(log).toEqual(["focus", "handler:onKeyDown"]);
    });

    it("keeps the store-ready gate for a global key only", async () => {
      state.storeReady = false;
      arrange();
      const wrapped = withWindowFocus(recordingHandler());

      await press(wrapped, "onKeyDown", "global");
      await press(wrapped, "onKeyDown", "no-focus");
      await press(wrapped, "onKeyDown", "focus");

      expect(log).toEqual(["handler:onKeyDown", "handler:onKeyDown", "focus", "handler:onKeyDown"]);
    });

    it("keeps the elevation-mismatch gate for a focus key (#976)", async () => {
      state.elevationMismatch = true;
      arrange();
      const wrapped = withWindowFocus(recordingHandler());

      await press(wrapped, "onKeyDown", "focus");
      await press(wrapped, "onDialRotate", "focus");

      expect(log).toEqual(["handler:onKeyDown", "handler:onDialRotate"]);
    });

    it("keeps the post-timeout cooldown for a focus key, and asks again once it has passed", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      state.focusResult = FocusResult.FocusTimedOut;
      setMode("never");
      arrange();
      const wrapped = withWindowFocus(recordingHandler());

      await press(wrapped, "onKeyDown", "focus");
      vi.setSystemTime(Date.now() + FOCUS_TIMEOUT_COOLDOWN_MS - 1);
      await press(wrapped, "onKeyDown", "focus");
      vi.setSystemTime(Date.now() + 1);
      await press(wrapped, "onKeyDown", "focus");

      expect(log).toEqual([
        "focus",
        "handler:onKeyDown",
        "handler:onKeyDown",
        "focus",
        "handler:onKeyDown",
      ]);
    });

    it("logs the per-key debug line once per press", async () => {
      setMode("required");
      const logger = arrange();
      const wrapped = withWindowFocus(recordingHandler());

      await press(wrapped, "onKeyDown", "no-focus");
      await press(wrapped, "onKeyDown", "focus");
      await press(wrapped, "onKeyUp", "focus");

      const lines = vi.mocked(logger.debug).mock.calls.map(([line]) => line);
      expect(lines.filter((line) => line === "Focus skipped for this key (per-key setting)")).toHaveLength(1);
      expect(lines.filter((line) => line === "Focus requested by this key's setting")).toHaveLength(1);
    });
  });

  describe("a focus failure never stops the press", () => {
    it("runs the handler when the focuser throws", async () => {
      initWindowFocus(
        createLogger(),
        () => {
          throw new Error("native focus failed");
        },
        () => false,
        () => false,
      );
      const wrapped = withWindowFocus(recordingHandler());

      await press(wrapped, "onKeyDown", "focus");
      await press(wrapped, "onKeyDown", "global");

      expect(log).toEqual(["handler:onKeyDown", "handler:onKeyDown"]);
    });

    it.each(["global", "focus"] as const)("runs the handler when the settings read throws (%s)", async (override) => {
      arrange();
      state.throwOnRead = true;
      const wrapped = withWindowFocus(recordingHandler());

      await press(wrapped, "onKeyDown", override);
      await press(wrapped, "onDialRotate", override);

      expect(log.filter((entry) => entry.startsWith("handler:"))).toEqual([
        "handler:onKeyDown",
        "handler:onDialRotate",
      ]);
    });

    it("runs the handler when the focus service's logger throws", async () => {
      const logger = createLogger();
      vi.mocked(logger.debug).mockImplementation(() => {
        throw new Error("logger broke");
      });
      arrange(logger);
      const wrapped = withWindowFocus(recordingHandler());

      await press(wrapped, "onKeyDown", "no-focus");

      expect(log).toEqual(["handler:onKeyDown"]);
    });

    it("runs the handler when reading the event's settings throws, as global", async () => {
      arrange();
      const wrapped = withWindowFocus(recordingHandler());
      const settings = {
        get windowFocus(): never {
          throw new Error("settings getter threw");
        },
      };

      await wrapped.onKeyDown!({ action: context("ctx-1"), payload: { settings } });

      expect(log).toEqual(["focus", "handler:onKeyDown"]);
    });
  });

  describe("forwarding", () => {
    it("returns the handler's own promise result and rejection", async () => {
      arrange();
      const wrapped = withWindowFocus<unknown>({
        onKeyDown: () => Promise.reject(new Error("press failed")),
        onKeyUp: () => Promise.resolve(),
      });

      await expect(press(wrapped, "onKeyDown", "focus")).rejects.toThrow("press failed");
      await expect(press(wrapped, "onKeyUp", "focus")).resolves.toBeUndefined();
    });

    it("lets a synchronous throw out synchronously, after the press-time focus", () => {
      arrange();
      const wrapped = withWindowFocus<unknown>({
        onKeyDown: () => {
          throw new Error("sync throw");
        },
      });

      expect(() => press(wrapped, "onKeyDown", "focus")).toThrow("sync throw");
      expect(log).toEqual(["focus"]);
    });

    it("calls every member on the original instance, with the same event", async () => {
      arrange();
      const seen: string[] = [];
      const event = ev("focus");
      const shape: PressShape = { kind: "long" };

      class Action implements IDeckActionHandler<unknown> {
        private readonly name = "the-action";
        keyPressShape(e: IDeckEvent<unknown>): PressShape {
          seen.push(`keyPressShape:${this.name}:${e === event}`);

          return shape;
        }
        dialPressShape(e: IDeckEvent<unknown>): PressShape {
          seen.push(`dialPressShape:${this.name}:${e === event}`);

          return shape;
        }
        touchPressShape(): PressShape {
          seen.push(`touchPressShape:${this.name}`);

          return shape;
        }
        async onWillAppear(e: IDeckEvent<unknown>): Promise<void> {
          seen.push(`onWillAppear:${this.name}:${e === event}`);
        }
        async onWillDisappear(e: IDeckEvent<unknown>): Promise<void> {
          seen.push(`onWillDisappear:${this.name}:${e === event}`);
        }
        async onDidReceiveSettings(e: IDeckEvent<unknown>): Promise<void> {
          seen.push(`onDidReceiveSettings:${this.name}:${e === event}`);
        }
        async onKeyDown(e: IDeckEvent<unknown>): Promise<void> {
          seen.push(`onKeyDown:${this.name}:${e === event}`);
        }
        async onKeyUp(e: IDeckEvent<unknown>): Promise<void> {
          seen.push(`onKeyUp:${this.name}:${e === event}`);
        }
        async onDialDown(e: IDeckEvent<unknown>): Promise<void> {
          seen.push(`onDialDown:${this.name}:${e === event}`);
        }
        async onDialUp(e: IDeckEvent<unknown>): Promise<void> {
          seen.push(`onDialUp:${this.name}:${e === event}`);
        }
        async onDialRotate(): Promise<void> {
          seen.push(`onDialRotate:${this.name}`);
        }
        async onTouchTap(): Promise<void> {
          seen.push(`onTouchTap:${this.name}`);
        }
      }

      const wrapped = withWindowFocus(new Action());

      expect(wrapped.keyPressShape!(event)).toBe(shape);
      expect(wrapped.dialPressShape!(event)).toBe(shape);
      expect(wrapped.touchPressShape!(touchEv("focus"))).toBe(shape);
      await wrapped.onWillAppear!(event);
      await wrapped.onWillDisappear!(event);
      await wrapped.onDidReceiveSettings!(event);
      await wrapped.onKeyDown!(event);
      await wrapped.onKeyUp!(event);
      await wrapped.onDialDown!(event);
      await wrapped.onDialUp!(event);
      await wrapped.onDialRotate!(rotateEv("focus"));
      await wrapped.onTouchTap!(touchEv("focus"));

      expect(seen).toEqual([
        "keyPressShape:the-action:true",
        "dialPressShape:the-action:true",
        "touchPressShape:the-action",
        "onWillAppear:the-action:true",
        "onWillDisappear:the-action:true",
        "onDidReceiveSettings:the-action:true",
        "onKeyDown:the-action:true",
        "onKeyUp:the-action:true",
        "onDialDown:the-action:true",
        "onDialUp:the-action:true",
        "onDialRotate:the-action",
        "onTouchTap:the-action",
      ]);
    });

    it("leaves every member the handler lacks undefined, as the press-sound wrapper needs", () => {
      const wrapped = withWindowFocus<unknown>({});

      expect(Object.keys(wrapped).sort()).toEqual(
        [
          "keyPressShape",
          "dialPressShape",
          "touchPressShape",
          "onWillAppear",
          "onWillDisappear",
          "onDidReceiveSettings",
          "onKeyDown",
          "onKeyUp",
          "onDialDown",
          "onDialUp",
          "onDialRotate",
          "onTouchTap",
        ].sort(),
      );

      for (const value of Object.values(wrapped)) expect(value).toBeUndefined();
    });

    it("runs the lifecycle members outside any press scope", async () => {
      arrange();
      const scopes: unknown[] = [];
      const record = async (): Promise<void> => {
        scopes.push(getWindowFocusScope());
      };
      const wrapped = withWindowFocus<unknown>({
        onWillAppear: record,
        onWillDisappear: record,
        onDidReceiveSettings: record,
        onKeyDown: record,
      });

      await wrapped.onWillAppear!(ev("no-focus"));
      await wrapped.onWillDisappear!(ev("no-focus"));
      await wrapped.onDidReceiveSettings!(ev("no-focus"));
      await wrapped.onKeyDown!(ev("no-focus"));

      expect(scopes).toEqual([undefined, undefined, undefined, "no-focus"]);
    });
  });

  describe("the scope reaches the keystroke site", () => {
    /** How a handler sends its keystroke: through a binding, the keyboard directly, or the chat send's hook. */
    const SENDS = {
      tapBinding: async (): Promise<void> => {
        await getBindingDispatcher().tap(BINDING_KEY);
      },
      keyboard: async (): Promise<void> => {
        await getKeyboard().sendKeyCombination({ key: "f2", code: "F2" });
      },
      // Stands in for ChatCommand.sendMessage: its beforeKeystrokes hook is focusIRacingBeforeInput (#977).
      chat: async (): Promise<void> => {
        focusIRacingBeforeInput();
        log.push("send:chat");
      },
    } as const;

    type SendKind = keyof typeof SENDS;

    /** Keystroke-time focuses: global follows always and required, focus always asks, no-focus never does. */
    const expectedKeystrokeFocus = (override: Override, mode: Mode): number =>
      override === "focus" || (override === "global" && mode !== "never") ? 1 : 0;

    const cases = (Object.keys(SENDS) as SendKind[]).flatMap((kind) =>
      OVERRIDES.flatMap((override) => MODES.map((mode) => [kind, override, mode] as const)),
    );

    // Driven from onKeyUp, which has no press-time focus, so every focus logged is the keystroke's.
    it.each(cases)("a %s send in a %s key's release under %s focuses as the key says", async (kind, override, mode) => {
      setMode(mode);
      arrange();
      const wrapped = withWindowFocus(recordingHandler(() => SENDS[kind]()));

      await press(wrapped, "onKeyUp", override);

      const sends = keystrokeLog().filter((entry) => entry.startsWith("send:"));
      expect(sends).toHaveLength(1);
      expect(keystrokeLog()).toEqual([...Array(expectedKeystrokeFocus(override, mode)).fill("focus"), sends[0]]);
    });

    it.each([
      ["no-focus", "always", []],
      ["focus", "never", ["focus", "focus"]],
      ["global", "required", ["focus"]],
    ] as const)(
      "a key down on a %s key under %s focuses at press and keystroke as the key says",
      async (override, mode, focuses) => {
        setMode(mode);
        arrange();
        const wrapped = withWindowFocus(recordingHandler(() => SENDS.tapBinding()));

        await press(wrapped, "onKeyDown", override);

        expect(keystrokeLog()).toEqual([...focuses, "send:59"]);
      },
    );

    it.each(OVERRIDES)("reaches a touch tap's keystrokes on a %s key, under never", async (override) => {
      setMode("never");
      arrange();
      const wrapped = withWindowFocus(recordingHandler(() => SENDS.keyboard()));

      await press(wrapped, "onTouchTap", override);

      expect(keystrokeLog().filter((entry) => entry === "focus")).toHaveLength(override === "focus" ? 1 : 0);
    });

    describe("survives what the handler starts", () => {
      /** Each starts the send its own way inside the handler and resolves once it has gone out. */
      const STARTS: Record<string, (send: () => Promise<void>) => Promise<void>> = {
        "an await": async (send) => {
          await new Promise((r) => setImmediate(r));
          await send();
        },
        "a promise chain it does not await": (send) => {
          const done = deferred();
          void Promise.resolve()
            .then(() => new Promise((r) => setImmediate(r)))
            .then(send)
            .then(done.resolve);

          return done.promise;
        },
        "a setTimeout": (send) => {
          const done = deferred();
          setTimeout(() => void send().then(done.resolve), 5);

          return done.promise;
        },
        "a setInterval, every tick": (send) => {
          const done = deferred();
          let ticks = 0;
          const interval = setInterval(() => {
            ticks++;
            void send().then(() => {
              if (ticks === 3) {
                clearInterval(interval);
                done.resolve();
              }
            });
          }, 2);

          return done.promise;
        },
      };

      const starts = Object.keys(STARTS);

      it.each(starts)("%s keeps a no-focus key's scope under always", async (start) => {
        setMode("always");
        arrange();
        const finished = deferred();
        const wrapped = withWindowFocus<unknown>({
          onKeyUp: async () => {
            void STARTS[start](() => SENDS.keyboard()).then(finished.resolve);
          },
        });

        await press(wrapped, "onKeyUp", "no-focus");
        await finished.promise;

        expect(keystrokeLog().length).toBeGreaterThan(0);
        expect(keystrokeLog()).not.toContain("focus");
      });

      it.each(starts)("%s keeps a focus key's scope under never", async (start) => {
        setMode("never");
        arrange();
        const finished = deferred();
        const wrapped = withWindowFocus<unknown>({
          onKeyUp: async () => {
            void STARTS[start](() => SENDS.keyboard()).then(finished.resolve);
          },
        });

        await press(wrapped, "onKeyUp", "focus");
        await finished.promise;

        const entries = keystrokeLog();
        const sends = entries.filter((entry) => entry.startsWith("send:"));
        expect(sends.length).toBeGreaterThan(0);
        // Every send was preceded by its own focus.
        expect(entries).toEqual(sends.flatMap((send) => ["focus", send]));
      });
    });

    it("leaves a keystroke from outside any press to the global mode", async () => {
      setMode("always");
      arrange();
      const wrapped = withWindowFocus(recordingHandler());
      await press(wrapped, "onKeyDown", "no-focus");
      log.length = 0;

      await getKeyboard().sendKeyCombination({ key: "f2", code: "F2" });
      await new Promise<void>((resolve) => {
        setTimeout(
          () =>
            void getKeyboard()
              .sendKeyCombination({ key: "f2", code: "F2" })
              .then(() => resolve()),
          1,
        );
      });

      expect(keystrokeLog()).toEqual(["focus", "send:60", "focus", "send:60"]);
    });

    it("keeps two keys pressed together on their own values", async () => {
      setMode("required");
      arrange();
      const gateA = deferred();
      const gateB = deferred();
      const keyA = withWindowFocus<unknown>({
        onKeyDown: async () => {
          await gateA.promise;
          await getKeyboard().sendKeyCombination({ key: "f1", code: "F1" });
        },
      });
      const keyB = withWindowFocus<unknown>({
        onKeyDown: async () => {
          await gateB.promise;
          await getKeyboard().sendKeyCombination({ key: "f2", code: "F2" });
        },
      });

      // A (no-focus) is pressed first and finishes last, with B (focus) run in between.
      const pressA = press(keyA, "onKeyDown", "no-focus", "ctx-a");
      const pressB = press(keyB, "onKeyDown", "focus", "ctx-b");
      expect(log).toEqual(["focus"]); // B's press-time focus; required asks nothing at press for A
      log.length = 0;

      gateB.resolve();
      await pressB;
      gateA.resolve();
      await pressA;

      expect(keystrokeLog()).toEqual(["focus", "send:60", "send:59"]);
    });
  });

  describe("inside the press-sound wrapper", () => {
    beforeEach(() => {
      initPressSounds({ play: (sound) => log.push(`sound:${sound}`) });
      initializeSimConnection(createFakeSimConnection().connection);
    });

    it("plays the tap at a key down after the focus and the handler's synchronous part", async () => {
      arrange();
      const composed = withPressSounds(withWindowFocus(recordingHandler()));

      await composed.onKeyDown!(ev("focus"));

      expect(log).toEqual(["focus", "handler:onKeyDown", "sound:tap"]);
    });

    it("asks the handler's own shape through the focus wrapper", async () => {
      arrange();
      const handler = recordingHandler();
      handler.keyPressShape = () => ({ kind: "long" });
      const composed = withPressSounds(withWindowFocus(handler));

      await composed.onKeyDown!(ev("no-focus"));

      expect(log).toEqual(["handler:onKeyDown", "sound:long"]);
    });

    it("plays a hold's long sound at the threshold", async () => {
      vi.useFakeTimers();
      arrange();
      const handler = recordingHandler();
      handler.keyPressShape = () => ({ kind: "hold", thresholdMs: 300 });
      const composed = withPressSounds(withWindowFocus(handler));

      await composed.onKeyDown!(ev("no-focus"));
      vi.advanceTimersByTime(300);
      await composed.onKeyUp!(ev("no-focus"));

      expect(log).toEqual(["handler:onKeyDown", "sound:tap", "sound:long", "handler:onKeyUp"]);
    });

    it("classifies a short dial release with the default dial shape", async () => {
      arrange();
      const composed = withPressSounds(withWindowFocus(recordingHandler()));

      await composed.onDialDown!(ev("global"));
      await composed.onDialUp!(ev("global"));

      expect(log).toEqual(["focus", "handler:onDialDown", "handler:onDialUp", "sound:tap"]);
    });

    it("silences a release after a pressed rotation (push+turn)", async () => {
      arrange();
      const composed = withPressSounds(withWindowFocus(recordingHandler()));

      await composed.onDialDown!(ev("no-focus"));
      await composed.onDialRotate!(rotateEv("no-focus", true));
      await composed.onDialUp!(ev("no-focus"));

      expect(log).toEqual(["handler:onDialDown", "handler:onDialRotate", "handler:onDialUp"]);
    });

    it("plays a touch's tap without a press-time focus", async () => {
      arrange();
      const composed = withPressSounds(withWindowFocus(recordingHandler()));

      await composed.onTouchTap!(touchEv("focus"));

      expect(log).toEqual(["handler:onTouchTap", "sound:tap"]);
    });

    it("plays nothing for a member the action lacks", () => {
      const composed = withPressSounds(withWindowFocus<unknown>({}));

      expect(composed.onKeyDown).toBeUndefined();
      expect(composed.onDialDown).toBeUndefined();
      expect(composed.onTouchTap).toBeUndefined();
    });
  });
});

describe("readWindowFocusOverride (issue #1654)", () => {
  it.each([
    ["no settings", undefined, "global"],
    ["null settings", null, "global"],
    ["a string", "focus", "global"],
    ["no windowFocus", {}, "global"],
    ["focus", { windowFocus: "focus" }, "focus"],
    ["no-focus", { windowFocus: "no-focus" }, "no-focus"],
    ["global", { windowFocus: "global" }, "global"],
    ["a future value", { windowFocus: "sometimes" }, "global"],
  ])("reads %s", (_label, settings, expected) => {
    expect(readWindowFocusOverride(settings)).toBe(expected);
  });
});
