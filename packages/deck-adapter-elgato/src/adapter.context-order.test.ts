/**
 * The per-context ordering contract (#1597) on the Elgato adapter: deck-core's
 * `CONTEXT_EVENT_ORDER_SCENARIOS` run through the adapter's real dispatch, plus
 * the Elgato-specific checks the shared suite cannot make.
 *
 * The fake SDK below models `@elgato/streamdeck` 3.0's dispatch, not its state:
 * one connection emitter that calls every listener of a host event in
 * registration order without awaiting it (`@elgato/utils` `event-emitter.js`),
 * the per-action routes `actions.registerAction` adds in the SDK's own order,
 * each awaiting only its own listener and filtering on the manifest id
 * (`actions/service.js` `registerAction`), and the SDK-wide `onKeyDown` /
 * `onDialDown` / `onDialRotate` listeners on the same emitter. It deliberately
 * has no action store: the real SDK drops input for a context missing from
 * it, but then the suite would measure the SDK and not the adapter, whose own
 * `ContextEventOrder` gate is what the contract requires.
 */
import type StreamDeck from "@elgato/streamdeck";
import { type IDeckActionHandler } from "@iracedeck/deck-core";
import {
  CONTEXT_EVENT_ORDER_ACTION_UUID,
  CONTEXT_EVENT_ORDER_HOST_EVENTS,
  CONTEXT_EVENT_ORDER_SCENARIOS,
  type ContextEventOrderHarness,
  type ContextEventOrderHostEvent,
  type ContextEventOrderPayload,
} from "@iracedeck/deck-core/testing";
import { describe, expect, it, vi } from "vitest";

import { ElgatoPlatformAdapter } from "./adapter.js";

type Controller = "Keypad" | "Encoder" | "Neo";

/** A host message as the SDK's connection emits it. */
interface Frame {
  readonly event: ContextEventOrderHostEvent;
  /** The manifest id (UUID) of the action. */
  readonly action: string;
  readonly context: string;
  readonly device: string;
  readonly payload: Record<string, unknown>;
}

type ConnectionListener = (frame: Frame) => unknown;

/** What the SDK hands a listener: `new ActionEvent(action, frame)`. */
interface SdkActionEvent {
  readonly type: string;
  readonly action: Record<string, unknown> & { readonly id: string; readonly manifestId: string };
  readonly payload: Record<string, unknown>;
}

type SdkListener = (ev: SdkActionEvent) => unknown;

/** The SDK's per-action route order (`actions/service.js` `registerAction`), for the events the suite drives. */
const ROUTES: ReadonlyArray<readonly [ContextEventOrderHostEvent, string]> = [
  ["dialDown", "onDialDown"],
  ["dialUp", "onDialUp"],
  ["dialRotate", "onDialRotate"],
  ["didReceiveSettings", "onDidReceiveSettings"],
  ["keyDown", "onKeyDown"],
  ["keyUp", "onKeyUp"],
  ["touchTap", "onTouchTap"],
  ["willAppear", "onWillAppear"],
  ["willDisappear", "onWillDisappear"],
];

const KEY_EVENTS: ReadonlySet<ContextEventOrderHostEvent> = new Set(["keyDown", "keyUp"]);
const DIAL_EVENTS: ReadonlySet<ContextEventOrderHostEvent> = new Set(["dialDown", "dialUp", "dialRotate", "touchTap"]);

/** A `KeyAction` / `DialAction` / `NeoInfobarAction` as far as the adapter reads one. */
function sdkAction(frame: Frame, controller: Controller): SdkActionEvent["action"] {
  return {
    id: frame.context,
    manifestId: frame.action,
    controllerType: controller,
    device: { id: frame.device, type: 7 },
    isKey: () => controller === "Keypad",
    isDial: () => controller === "Encoder",
    isNeoInfobar: () => controller === "Neo",
    setImage: async () => undefined,
    setTitle: async () => undefined,
    setSettings: async () => undefined,
    setFeedback: async () => undefined,
    setFeedbackLayout: async () => undefined,
    setTriggerDescription: async () => undefined,
    showAlert: async () => undefined,
  };
}

/** The SDK's `ActionContext`, which a `willDisappear` carries: no methods, the controller as a property. */
function sdkActionContext(frame: Frame, controller: Controller): SdkActionEvent["action"] {
  return { id: frame.context, manifestId: frame.action, controllerType: controller, device: { id: frame.device } };
}

/**
 * The fake SDK over one connection emitter. `emit` delivers one host message
 * synchronously to every listener, in registration order, as the SDK's
 * connection does, and returns without awaiting what they started.
 */
function createFakeSdk() {
  const listeners = new Map<string, ConnectionListener[]>();
  /** The controller each context last appeared as: what the host would stamp on its later frames. */
  const controllers = new Map<string, Controller>();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
  const scopes: string[] = [];

  const on = (event: string, listener: ConnectionListener): void => {
    const list = listeners.get(event) ?? [];

    list.push(listener);
    listeners.set(event, list);
  };

  const controllerOf = (frame: Frame): Controller => {
    if (KEY_EVENTS.has(frame.event)) return "Keypad";

    if (DIAL_EVENTS.has(frame.event)) return "Encoder";

    return controllers.get(frame.context) ?? "Keypad";
  };

  const actionEvent = (frame: Frame): SdkActionEvent => {
    const controller = controllerOf(frame);
    const action = frame.event === "willDisappear" ? sdkActionContext(frame, controller) : sdkAction(frame, controller);

    return { type: frame.event, action, payload: frame.payload };
  };

  const sdkWide =
    (event: ContextEventOrderHostEvent) =>
    (listener: SdkListener): void =>
      on(event, (frame) => listener(actionEvent(frame)));

  const scopeLogger = { ...log, createScope: () => scopeLogger, setLevel: vi.fn() };

  const sd = {
    logger: {
      createScope: (scope: string) => {
        scopes.push(scope);

        return scopeLogger;
      },
      setLevel: vi.fn(),
    },
    ui: { onSendToPlugin: vi.fn() },
    actions: {
      onKeyDown: sdkWide("keyDown"),
      onDialDown: sdkWide("dialDown"),
      onDialRotate: sdkWide("dialRotate"),
      registerAction: (action: Record<string, unknown> & { manifestId: string }): void => {
        for (const [event, method] of ROUTES) {
          const listener = action[method];

          if (typeof listener !== "function") continue;

          const bound = (listener as SdkListener).bind(action);

          on(event, async (frame) => {
            const ev = actionEvent(frame);

            if (ev.action.manifestId == action.manifestId) await bound(ev);
          });
        }
      },
    },
  };

  /**
   * Hand one host message to every listener of its event, in registration
   * order, awaiting none, as the SDK's emitter does; returns what each listener
   * returned (the SDK discards it), so a test can see a route's rejection.
   */
  const deliver = (
    event: ContextEventOrderHostEvent,
    context: string,
    payload: ContextEventOrderPayload,
  ): unknown[] => {
    const body: Record<string, unknown> = {
      settings: payload.settings ?? {},
      coordinates: { row: 0, column: 0 },
    };

    if (event === "willAppear" || event === "willDisappear" || event === "didReceiveSettings") {
      body.controller = controllers.get(context) ?? "Keypad";
      body.isInMultiAction = false;
    }

    if (event === "dialRotate") {
      body.ticks = payload.ticks ?? 1;
      body.pressed = payload.pressed ?? false;
    }

    if (event === "touchTap") {
      body.tapPos = [0, 0];
      body.hold = false;
    }

    const frame: Frame = { event, action: CONTEXT_EVENT_ORDER_ACTION_UUID, context, device: "dev-1", payload: body };

    return [...(listeners.get(event) ?? [])].map((listener) => listener(frame));
  };

  /** The harness's `emit`: a `willAppear` sets the controller the context's later frames carry. */
  const emit = (event: ContextEventOrderHostEvent, context: string, payload: ContextEventOrderPayload = {}): void => {
    if (event === "willAppear") controllers.set(context, payload.controller ?? "Keypad");

    deliver(event, context, payload);
  };

  /** Appear a context as any controller, a Neo Infobar included, which the suite never drives. */
  const appearAs = (context: string, controller: Controller): void => {
    controllers.set(context, controller);
    deliver("willAppear", context, {});
  };

  /** How many listeners the host event has: one per bridge route plus one per SDK-wide subscriber. */
  const listenerCount = (event: ContextEventOrderHostEvent): number => listeners.get(event)?.length ?? 0;

  return { sd: sd as unknown as typeof StreamDeck, emit, deliver, appearAs, listenerCount, log, scopes };
}

function createHarness(): ContextEventOrderHarness {
  const fake = createFakeSdk();

  return {
    adapter: new ElgatoPlatformAdapter(fake.sd),
    hostEvents: CONTEXT_EVENT_ORDER_HOST_EVENTS,
    // The SDK delivers input only for a context in its action store, so a
    // context the host never appeared gets nothing; the adapter drops it at
    // arrival as well, which is what this harness measures.
    neverAppeared: "drop",
    emit: fake.emit,
  };
}

describe("ElgatoPlatformAdapter per-context ordering contract (#1597)", () => {
  it.each(CONTEXT_EVENT_ORDER_SCENARIOS)("$name", async ({ run }) => run(createHarness()));
});

describe("ElgatoPlatformAdapter per-context ordering, Elgato specifics (#1597)", () => {
  const UUID = CONTEXT_EVENT_ORDER_ACTION_UUID;

  function setup(handler: IDeckActionHandler) {
    const fake = createFakeSdk();
    const adapter = new ElgatoPlatformAdapter(fake.sd);

    adapter.registerAction(UUID, handler);

    return { fake, adapter };
  }

  it("calls a handler with nothing ahead of it inside the SDK's own callback, as before the order existed", async () => {
    const calls: string[] = [];
    const { fake } = setup({
      onWillAppear: async () => {
        calls.push("willAppear");
      },
      onKeyDown: async () => {
        calls.push("keyDown");
      },
    });

    fake.emit("willAppear", "ctx-1");
    expect(calls).toEqual(["willAppear"]);

    // Let the appear's promise settle, so the press overlaps nothing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.emit("keyDown", "ctx-1");
    expect(calls).toEqual(["willAppear", "keyDown"]);
  });

  it("hands the SDK's route the handler's rejection, so a failing handler is reported as it was", async () => {
    const failure = new Error("handler blew up");
    const { fake } = setup({
      onWillAppear: async () => undefined,
      onKeyDown: async () => {
        throw failure;
      },
    });

    fake.emit("willAppear", "ctx-1");
    const [route] = fake.deliver("keyDown", "ctx-1", {});

    await expect(route).rejects.toBe(failure);
  });

  it("still runs the events behind a handler that threw", async () => {
    const calls: string[] = [];
    const { fake } = setup({
      onWillAppear: async () => {
        calls.push("willAppear");
        throw new Error("appear failed");
      },
      onKeyDown: async () => {
        calls.push("keyDown");
      },
    });

    const [appear] = fake.deliver("willAppear", "ctx-1", {});
    const [press] = fake.deliver("keyDown", "ctx-1", {});

    await expect(appear).rejects.toThrow("appear failed");
    await press;
    expect(calls).toEqual(["willAppear", "keyDown"]);
  });

  it("never makes a Neo Infobar context live: its settings and disappear never reach the handler, and nothing is warned", async () => {
    const handler = { onWillAppear: vi.fn(), onDidReceiveSettings: vi.fn(), onWillDisappear: vi.fn() };
    const { fake } = setup(handler);

    fake.appearAs("ctx-infobar", "Neo");
    fake.emit("didReceiveSettings", "ctx-infobar");
    fake.emit("willDisappear", "ctx-infobar");
    await Promise.resolve();

    expect(handler.onWillAppear).not.toHaveBeenCalled();
    expect(handler.onDidReceiveSettings).not.toHaveBeenCalled();
    expect(handler.onWillDisappear).not.toHaveBeenCalled();
    expect(fake.log.warn).not.toHaveBeenCalled();
  });

  it("logs a drop for a context that never appeared through its own ContextEventOrder scope, warning once", () => {
    const { fake } = setup({ onKeyDown: vi.fn() });

    fake.emit("keyDown", "ctx-ghost");
    fake.emit("keyDown", "ctx-ghost");

    expect(fake.scopes).toContain("ContextEventOrder");
    expect(fake.log.warn).toHaveBeenCalledExactlyOnceWith(
      "Dropped keyDown for ctx-ghost: it never appeared (the host sent no willAppear for it)",
    );
  });

  it("bridges a UUID once: registering it again replaces the handler and adds no second SDK route", () => {
    const first = { onWillAppear: vi.fn(), onKeyDown: vi.fn() };
    const second = { onWillAppear: vi.fn(), onKeyDown: vi.fn() };
    const { fake, adapter } = setup(first);

    expect(fake.listenerCount("keyDown")).toBe(1);

    adapter.registerAction(UUID, second);

    expect(fake.listenerCount("keyDown")).toBe(1);

    fake.emit("willAppear", "ctx-1");
    fake.emit("keyDown", "ctx-1");

    expect(first.onWillAppear).not.toHaveBeenCalled();
    expect(first.onKeyDown).not.toHaveBeenCalled();
    expect(second.onWillAppear).toHaveBeenCalledOnce();
    expect(second.onKeyDown).toHaveBeenCalledOnce();
  });

  it("gates the broadcast on the context the SDK-wide listener is handed, not on any context being live", () => {
    const { fake, adapter } = setup({ onWillAppear: vi.fn(), onKeyDown: vi.fn() });
    const broadcast = vi.fn();

    adapter.onKeyDown(broadcast);
    fake.emit("willAppear", "ctx-live");
    fake.emit("keyDown", "ctx-other");

    expect(broadcast).not.toHaveBeenCalled();

    fake.emit("keyDown", "ctx-live");

    expect(broadcast).toHaveBeenCalledOnce();
  });
});
