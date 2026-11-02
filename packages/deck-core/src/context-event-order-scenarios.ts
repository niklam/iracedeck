/**
 * The per-context ordering contract suite every deck adapter runs (#1597,
 * decision 6). Reached as `@iracedeck/deck-core/testing`; never imported by
 * production code.
 *
 * Each scenario is a plain async function over a {@link ContextEventOrderHarness}
 * the adapter's test supplies; it registers its own recording handler through
 * the adapter's real `registerAction`, drives host events through the harness's
 * `emit`, and throws when a rule of `IDeckPlatformAdapter.registerAction`'s
 * contract is broken. Nothing here imports `vitest`: an adapter's test runs the
 * list with `it.each(CONTEXT_EVENT_ORDER_SCENARIOS)("$name", ({ run }) => run(createHarness()))`,
 * one fresh harness per scenario, and `scripts/deck-adapter-order-contract.test.mjs`
 * fails an adapter package whose tests do not.
 *
 * Every drop check is preceded by a delivery check on the same harness, so a
 * harness whose `emit` reaches nothing fails rather than passing vacuously.
 *
 * deck-core's own test runs the list against reference adapters kept beside
 * it (`context-event-order-reference-adapters.test-support.ts`) — one that
 * calls handlers at arrival, one that serialises everything, one that fires
 * broadcasts inside the task and one that decides liveness there — asserting
 * scenario by scenario which reference each fails on, so no scenario can pass
 * vacuously, and against two built on `ContextEventOrder` (one per
 * never-appeared policy) on which every scenario passes.
 */
import type { ContextHandlerEventKind } from "./context-event-order.js";
import type {
  IDeckActionHandler,
  IDeckDialRotateEvent,
  IDeckEvent,
  IDeckPlatformAdapter,
  IDeckTouchTapEvent,
} from "./types.js";

/** The action UUID the suite registers its handler under; a harness routes this UUID's events. */
export const CONTEXT_EVENT_ORDER_ACTION_UUID = "com.iracedeck.testing.context-event-order";

/** A host event the harness delivers, named as the handler events are. */
export type ContextEventOrderHostEvent = ContextHandlerEventKind;

/** The input host events, in the order the suite drives them. */
export const CONTEXT_EVENT_ORDER_INPUT_EVENTS: readonly ContextEventOrderHostEvent[] = [
  "keyDown",
  "keyUp",
  "dialDown",
  "dialUp",
  "dialRotate",
  "touchTap",
];

/** Every host event, for a harness whose host sends them all (Elgato). */
export const CONTEXT_EVENT_ORDER_HOST_EVENTS: readonly ContextEventOrderHostEvent[] = [
  "willAppear",
  "willDisappear",
  "didReceiveSettings",
  ...CONTEXT_EVENT_ORDER_INPUT_EVENTS,
];

/**
 * What a scenario may ask the host event to carry. Every field is optional and
 * the harness fills its host's defaults for the rest; a scenario that passes
 * none is driving the order, not the payload.
 */
export interface ContextEventOrderPayload {
  readonly settings?: Record<string, unknown>;
  /**
   * `willAppear` only: the controller the context appears as. The suite drives
   * the dial input kinds on a context appeared as `Encoder`, so a host that
   * promotes a Keypad context on dial input (Ulanzi) sees no promotion in the
   * ordering scenarios. The harness reports it the way its host would — the
   * frame's `controller` on Mirabox and Ulanzi, a dial-shaped fake action on
   * Elgato.
   */
  readonly controller?: "Keypad" | "Encoder";
  /** `dialRotate` only. */
  readonly ticks?: number;
  /** `dialRotate` only. */
  readonly pressed?: boolean;
}

/**
 * What an adapter does with input for a context the host never sent a
 * `willAppear` for (decision 3):
 *
 * - `"drop"` — it never reaches the handler and fires no broadcast. Elgato's
 *   SDK already does this, and so does the primitive by default.
 * - `"appear-first"` — the adapter enqueues a `willAppear` for the context
 *   ahead of the input (`!order.isLive(c) && !order.hasAppeared(c)`), so the
 *   input runs after that appear and its broadcast fires, the context being
 *   live by the time the input arrives. Ulanzi, whose host sends input with no
 *   prior `add`. Only a context that NEVER appeared gets this; one that has
 *   disappeared is dropped under both policies, or the #1329 leak returns.
 *   The host's own `willAppear`, arriving later for the context the adapter
 *   appeared on input, is live-context appear: it is delivered as a
 *   `didReceiveSettings` carrying that frame's settings, ordered as an
 *   exclusive event, so the handler sees the settings the host meant without
 *   a second `onWillAppear`.
 *
 * Under both policies a `willAppear` for a context that is already live never
 * calls `onWillAppear` (the primitive drops it at arrival).
 */
export type ContextEventOrderNeverAppearedPolicy = "drop" | "appear-first";

/**
 * The part of `IDeckPlatformAdapter` the suite drives: the registration it
 * puts its recording handler through, and the three broadcasts it counts.
 * Narrowed so a test double of an adapter (deck-core's references) need not
 * implement the whole interface.
 */
export type ContextEventOrderAdapter = Pick<
  IDeckPlatformAdapter,
  "registerAction" | "onKeyDown" | "onDialDown" | "onDialRotate"
>;

/**
 * What an adapter's test supplies to run the suite. Make one per scenario: a
 * scenario leaves contexts live and handlers registered behind it.
 */
export interface ContextEventOrderHarness {
  /** The adapter under test, constructed over a fake host. */
  readonly adapter: ContextEventOrderAdapter;
  /**
   * The host events this host sends, so the suite drives each input kind the
   * adapter dispatches and no other. Elgato sends them all
   * ({@link CONTEXT_EVENT_ORDER_HOST_EVENTS}); Mirabox has no `dialUp` or
   * `touchTap` host event, since its `dialDown` runs the handler's down and
   * up. Must include the three lifecycle events and `keyDown`.
   */
  readonly hostEvents: readonly ContextEventOrderHostEvent[];
  /** What the adapter does with input for a context that never appeared. */
  readonly neverAppeared: ContextEventOrderNeverAppearedPolicy;
  /**
   * Deliver one host event for `context` **synchronously**, through the
   * adapter's real dispatch — a fake SDK emitting to the registered
   * `BridgeAction` on Elgato, the client's routed action event on Mirabox and
   * Ulanzi — exactly as the host would, and return without awaiting what the
   * dispatch started. The event is for {@link CONTEXT_EVENT_ORDER_ACTION_UUID}.
   * Only called with an event in `hostEvents`.
   */
  emit(event: ContextEventOrderHostEvent, context: string, payload?: ContextEventOrderPayload): void;
}

/** One rule of the contract, as a named check over a fresh harness. */
export interface ContextEventOrderScenario {
  readonly name: string;
  /** Throws, with the rule and what happened instead, when the adapter breaks it. */
  run(harness: ContextEventOrderHarness): Promise<void>;
}

/** A promise the scenario opens by hand, standing in for a handler's await. */
interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

/**
 * Let every promise continuation that is ready run, including the chains they
 * start. A bounded microtask loop rather than a timer, so it works under fake
 * timers and takes no dependency on the host's clock; an adapter's dispatch
 * from `emit` to the handler is promise hops only, far fewer than this.
 */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 100; hop += 1) await Promise.resolve();
}

/** The handler calls recorded so far, plus the subscriptions the action-shaped fake holds. */
interface Recording {
  readonly calls: string[];
  readonly subscriptions: Set<string>;
  /** The settings each `onDidReceiveSettings` call carried, in call order. */
  readonly settingsReceived: unknown[];
  readonly handler: IDeckActionHandler;
}

/**
 * The suite's handler: records `<event>` when a handler method starts and
 * `<event>:done` when it finishes, awaiting the gate given for that event in
 * between. Shaped like an action's lifecycle: the appear subscribes the context
 * id after its await, the disappear unsubscribes it, so the leak the contract
 * closes shows up as a subscription left behind.
 */
function record(gates: Partial<Record<ContextHandlerEventKind, Gate>> = {}): Recording {
  const calls: string[] = [];
  const subscriptions = new Set<string>();
  const settingsReceived: unknown[] = [];

  const step = async (event: ContextHandlerEventKind, ev: IDeckEvent<unknown>): Promise<void> => {
    calls.push(event);

    if (event === "didReceiveSettings") settingsReceived.push(ev.payload.settings);

    const open = gates[event];

    if (open) await open.promise;

    if (event === "willAppear") subscriptions.add(ev.action.id);

    if (event === "willDisappear") subscriptions.delete(ev.action.id);

    calls.push(`${event}:done`);
  };

  const handler: IDeckActionHandler = {
    onWillAppear: (ev) => step("willAppear", ev),
    onWillDisappear: (ev) => step("willDisappear", ev),
    onDidReceiveSettings: (ev) => step("didReceiveSettings", ev),
    onKeyDown: (ev) => step("keyDown", ev),
    onKeyUp: (ev) => step("keyUp", ev),
    onDialDown: (ev) => step("dialDown", ev),
    onDialUp: (ev) => step("dialUp", ev),
    onDialRotate: (ev: IDeckDialRotateEvent<unknown>) => step("dialRotate", ev),
    onTouchTap: (ev: IDeckTouchTapEvent<unknown>) => step("touchTap", ev),
  };

  return { calls, subscriptions, settingsReceived, handler };
}

function same(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

/** Throws when the recorded calls are not exactly `expected`, naming the rule. */
function expectCalls(rule: string, actual: readonly string[], expected: readonly string[]): void {
  if (same(actual, expected)) return;

  throw new Error(`${rule}: expected handler calls [${expected.join(", ")}] but saw [${actual.join(", ")}]`);
}

function expectCount(rule: string, what: string, actual: number, expected: number): void {
  if (actual === expected) return;

  throw new Error(`${rule}: expected ${what} to have fired ${expected} time(s) but it fired ${actual}`);
}

/** The input kinds this harness's host sends. */
function supportedInputs(harness: ContextEventOrderHarness): readonly ContextEventOrderHostEvent[] {
  return CONTEXT_EVENT_ORDER_INPUT_EVENTS.filter((event) => harness.hostEvents.includes(event));
}

/** `emit` with the payload an input kind needs. */
function emitInput(harness: ContextEventOrderHarness, event: ContextEventOrderHostEvent, context: string): void {
  harness.emit(event, context, event === "dialRotate" ? { ticks: 1, pressed: false } : undefined);
}

const DIAL_INPUTS: ReadonlySet<ContextEventOrderHostEvent> = new Set(["dialDown", "dialUp", "dialRotate", "touchTap"]);

/** The controller a context is appeared as before `event` is driven on it. */
function controllerFor(event: ContextEventOrderHostEvent): "Keypad" | "Encoder" {
  return DIAL_INPUTS.has(event) ? "Encoder" : "Keypad";
}

/**
 * Appear `context` and deliver a `keyDown` to it, settled, so the harness is
 * shown to reach the handler before a drop check on the same harness.
 */
async function proveDelivery(harness: ContextEventOrderHarness, calls: string[], context: string): Promise<void> {
  harness.emit("willAppear", context);
  await settle();
  harness.emit("keyDown", context);
  await settle();

  expectCalls("the harness delivers events to the handler (delivery check before a drop check)", calls.slice(-4), [
    "willAppear",
    "willAppear:done",
    "keyDown",
    "keyDown:done",
  ]);
}

const slowAppearThenEarlyDisappear: ContextEventOrderScenario = {
  name: "a slow appear, then an early disappear: the disappear starts only after the appear settles",
  async run({ adapter, emit }) {
    const appear = gate();
    const { calls, subscriptions, handler } = record({ willAppear: appear });
    const rule = "a willDisappear waits for the willAppear of its context";

    adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    emit("willAppear", "ctx-1");
    emit("willDisappear", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear"]);

    appear.open();
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "willDisappear", "willDisappear:done"]);

    if (subscriptions.size !== 0) {
      throw new Error(`${rule}: the context is gone but its appear's subscription was left behind (the #1597 leak)`);
    }
  },
};

const noOvertaking: ContextEventOrderScenario = {
  name: "no overtaking: with an appear in flight, an input then a disappear run in that order, each after the one before settles",
  async run({ adapter, emit }) {
    const appear = gate();
    const press = gate();
    const { calls, handler } = record({ willAppear: appear, keyDown: press });
    const rule = "input waits for an earlier lifecycle event, and a lifecycle event waits for input in flight";

    adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    emit("willAppear", "ctx-1");
    emit("keyDown", "ctx-1");
    emit("willDisappear", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear"]);

    appear.open();
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "keyDown"]);

    press.open();
    await settle();

    expectCalls(rule, calls, [
      "willAppear",
      "willAppear:done",
      "keyDown",
      "keyDown:done",
      "willDisappear",
      "willDisappear:done",
    ]);
  },
};

const everyInputKindWaitsForLifecycle: ContextEventOrderScenario = {
  name: "every supported input kind waits for an earlier lifecycle event and holds a later one",
  async run(harness) {
    const inputs = supportedInputs(harness);

    if (inputs.length === 0) throw new Error("the harness declares no input host event; it must at least send keyDown");

    // One registration for every kind, as production registers each UUID once:
    // the gates are swapped per kind, and `record` reads them when a call starts.
    const gates: Partial<Record<ContextHandlerEventKind, Gate>> = {};
    const { calls, handler } = record(gates);

    harness.adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    for (const kind of inputs) {
      const appear = gate();
      const input = gate();
      const rule = `${kind} waits for an earlier willAppear and holds a later willDisappear`;
      const context = `ctx-${kind}`;
      const from = calls.length;
      // A host event may be several handler calls (Mirabox's dialDown runs
      // dialUp too): only the lifecycle calls and the kind under test are compared.
      const relevant = (): string[] =>
        calls.slice(from).filter((call) => /^will(Appear|Disappear)/.test(call) || call.startsWith(kind));

      for (const key of Object.keys(gates) as ContextHandlerEventKind[]) delete gates[key];

      gates.willAppear = appear;
      gates[kind] = input;

      harness.emit("willAppear", context, { controller: controllerFor(kind) });
      emitInput(harness, kind, context);
      harness.emit("willDisappear", context);
      await settle();

      expectCalls(rule, relevant(), ["willAppear"]);

      appear.open();
      await settle();

      expectCalls(rule, relevant(), ["willAppear", "willAppear:done", kind]);

      input.open();
      await settle();

      expectCalls(rule, relevant(), [
        "willAppear",
        "willAppear:done",
        kind,
        `${kind}:done`,
        "willDisappear",
        "willDisappear:done",
      ]);
    }
  },
};

const settingsChangeIsExclusive: ContextEventOrderScenario = {
  name: "a settings change is exclusive: input waits for it, and it waits for input in flight",
  async run({ adapter, emit }) {
    const settings = gate();
    const press = gate();
    const { calls, handler } = record({ didReceiveSettings: settings, keyDown: press });
    const rule = "didReceiveSettings waits for every earlier event of its context and holds every later one";
    const upToPress = ["willAppear", "willAppear:done", "didReceiveSettings", "didReceiveSettings:done", "keyDown"];

    adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    emit("willAppear", "ctx-1");
    await settle();
    emit("didReceiveSettings", "ctx-1");
    emit("keyDown", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "didReceiveSettings"]);

    settings.open();
    await settle();

    expectCalls(rule, calls, upToPress);

    // The press is now in flight on its gate; a second settings change waits for it.
    emit("didReceiveSettings", "ctx-1");
    await settle();

    expectCalls(rule, calls, upToPress);

    press.open();
    await settle();

    expectCalls(rule, calls, [...upToPress, "keyDown:done", "didReceiveSettings", "didReceiveSettings:done"]);
  },
};

const reappearWaitsForTeardown: ContextEventOrderScenario = {
  name: "a re-appear after a disappear runs only after the teardown settles",
  async run({ adapter, emit }) {
    const teardown = gate();
    const { calls, handler } = record({ willDisappear: teardown });
    const rule = "a willAppear after a willDisappear of the same context waits for that teardown";

    adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    emit("willAppear", "ctx-1");
    await settle();
    emit("willDisappear", "ctx-1");
    emit("willAppear", "ctx-1");
    emit("keyDown", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "willDisappear"]);

    teardown.open();
    await settle();

    expectCalls(rule, calls, [
      "willAppear",
      "willAppear:done",
      "willDisappear",
      "willDisappear:done",
      "willAppear",
      "willAppear:done",
      "keyDown",
      "keyDown:done",
    ]);
  },
};

const lateAppearForLiveContext: ContextEventOrderScenario = {
  name: "a willAppear for a context that is already live never calls onWillAppear",
  async run(harness) {
    const press = gate();
    const { calls, settingsReceived, handler } = record({ keyDown: press });

    harness.adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    if (harness.neverAppeared === "drop") {
      const rule = "a second willAppear for a live context is dropped at arrival";

      harness.emit("willAppear", "ctx-1", { settings: { marker: 1 } });
      await settle();
      harness.emit("willAppear", "ctx-1", { settings: { marker: 2 } });
      await settle();

      expectCalls(rule, calls, ["willAppear", "willAppear:done"]);

      // Still live: input runs, and the keyDown gate is not in this branch's way once opened.
      press.open();
      harness.emit("keyDown", "ctx-1");
      await settle();

      expectCalls(rule, calls, ["willAppear", "willAppear:done", "keyDown", "keyDown:done"]);

      return;
    }

    const rule =
      "the host's late willAppear for a context appeared on input is one didReceiveSettings with the frame's settings, ordered as exclusive";

    // Input appears the context; the host's own add follows while the input is still in flight.
    harness.emit("keyDown", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "keyDown"]);

    harness.emit("willAppear", "ctx-1", { settings: { marker: "from-the-host" } });
    await settle();

    // Exclusive: it waits for the press in flight, and never runs as an appear.
    expectCalls(rule, calls, ["willAppear", "willAppear:done", "keyDown"]);

    press.open();
    await settle();

    expectCalls(rule, calls, [
      "willAppear",
      "willAppear:done",
      "keyDown",
      "keyDown:done",
      "didReceiveSettings",
      "didReceiveSettings:done",
    ]);

    const [received] = settingsReceived;

    if (settingsReceived.length !== 1 || (received as { marker?: unknown } | undefined)?.marker !== "from-the-host") {
      throw new Error(
        `${rule}: expected one settings call carrying the frame's settings but saw ${JSON.stringify(settingsReceived)}`,
      );
    }
  },
};

const inputAfterDisappearIsDropped: ContextEventOrderScenario = {
  name: "input after a disappear is dropped",
  async run(harness) {
    const { calls, handler } = record();
    const rule = "an event for a context whose willDisappear has arrived never reaches the handler";

    harness.adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    await proveDelivery(harness, calls, "ctx-1");
    harness.emit("willDisappear", "ctx-1");
    await settle();

    const delivered = [
      "willAppear",
      "willAppear:done",
      "keyDown",
      "keyDown:done",
      "willDisappear",
      "willDisappear:done",
    ];

    expectCalls(rule, calls, delivered);

    for (const kind of supportedInputs(harness)) emitInput(harness, kind, "ctx-1");

    harness.emit("didReceiveSettings", "ctx-1");
    harness.emit("willDisappear", "ctx-1");
    await settle();

    expectCalls(rule, calls, delivered);
  },
};

const inputBeforeAppearFollowsPolicy: ContextEventOrderScenario = {
  name: "input before any appear is dropped, or appears the context first under the appear-first policy",
  async run(harness) {
    const { calls, handler } = record();

    harness.adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    // Another context first, so the drop below is a drop and not a harness that reaches nothing.
    await proveDelivery(harness, calls, "ctx-2");
    calls.length = 0;

    if (harness.neverAppeared === "drop") {
      const rule = "an event for a context the host never sent a willAppear for never reaches the handler";

      for (const kind of supportedInputs(harness)) emitInput(harness, kind, "ctx-1");

      harness.emit("didReceiveSettings", "ctx-1");
      harness.emit("willDisappear", "ctx-1");
      await settle();

      expectCalls(rule, calls, []);

      return;
    }

    const rule = "input for a context the host never sent a willAppear for runs after an appear for it (appear-first)";

    harness.emit("keyDown", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "keyDown", "keyDown:done"]);

    // Now live: more input runs on it with no second appear.
    harness.emit("keyUp", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "keyDown", "keyDown:done", "keyUp", "keyUp:done"]);
  },
};

const twoInputsRunConcurrently: ContextEventOrderScenario = {
  name: "two inputs run concurrently (both start before either settles)",
  async run({ adapter, emit }) {
    const press = gate();
    const { calls, handler } = record({ keyDown: press });
    const rule = "input does not wait for earlier input";

    adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    emit("willAppear", "ctx-1");
    await settle();
    emit("keyDown", "ctx-1");
    emit("keyDown", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "keyDown", "keyDown"]);

    press.open();
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "keyDown", "keyDown", "keyDown:done", "keyDown:done"]);
  },
};

/** The three broadcast counters the suite subscribes. */
interface Fired {
  keyDown: number;
  dialDown: number;
  dialRotate: number;
}

function subscribeBroadcasts(adapter: ContextEventOrderAdapter): Fired {
  const fired: Fired = { keyDown: 0, dialDown: 0, dialRotate: 0 };

  adapter.onKeyDown(() => {
    fired.keyDown += 1;
  });
  adapter.onDialDown(() => {
    fired.dialDown += 1;
  });
  adapter.onDialRotate(() => {
    fired.dialRotate += 1;
  });

  return fired;
}

function expectFired(rule: string, when: string, fired: Fired, expected: Fired): void {
  expectCount(rule, `the key-down broadcast ${when}`, fired.keyDown, expected.keyDown);
  expectCount(rule, `the dial-down broadcast ${when}`, fired.dialDown, expected.dialDown);
  expectCount(rule, `the dial-rotate broadcast ${when}`, fired.dialRotate, expected.dialRotate);
}

const broadcastsFireForLiveContextsOnly: ContextEventOrderScenario = {
  name: "broadcasts fire only for a live context",
  async run(harness) {
    const { handler } = record();
    const rule = "onKeyDown / onDialDown / onDialRotate fire for a live context only";
    const fired = subscribeBroadcasts(harness.adapter);
    const dials = harness.hostEvents.includes("dialDown") && harness.hostEvents.includes("dialRotate");

    harness.adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    const each = (): void => {
      harness.emit("keyDown", "ctx-1");

      if (dials) {
        harness.emit("dialDown", "ctx-1");
        harness.emit("dialRotate", "ctx-1", { ticks: 1, pressed: false });
      }
    };
    const counts = (n: number): Fired => ({ keyDown: n, dialDown: dials ? n : 0, dialRotate: dials ? n : 0 });

    // Never appeared: nothing fires under "drop"; under "appear-first" the
    // context is live by the time the input arrives, so each fires once.
    each();
    await settle();

    const beforeAppear = harness.neverAppeared === "drop" ? 0 : 1;

    expectFired(rule, `for a context that never appeared (${harness.neverAppeared})`, fired, counts(beforeAppear));

    // Live: each fires once per event.
    harness.emit("willAppear", "ctx-1");
    await settle();
    each();
    await settle();

    expectFired(rule, "for a live context", fired, counts(beforeAppear + 1));

    // Disappeared: nothing more fires.
    harness.emit("willDisappear", "ctx-1");
    await settle();
    each();
    await settle();

    expectFired(rule, "for a context that disappeared", fired, counts(beforeAppear + 1));
  },
};

const broadcastFiresAtArrival: ContextEventOrderScenario = {
  name: "a broadcast fires at the input's arrival, while the appear the input waits for is still running",
  async run({ adapter, emit }) {
    const appear = gate();
    const { calls, handler } = record({ willAppear: appear });
    const rule = "a broadcast fires at arrival, not when the handler runs";
    const fired = subscribeBroadcasts(adapter);

    adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    emit("willAppear", "ctx-1");
    emit("keyDown", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear"]);
    expectCount(rule, "the key-down broadcast while its input waits for the appear", fired.keyDown, 1);

    appear.open();
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "keyDown", "keyDown:done"]);
    expectCount(rule, "the key-down broadcast after the input ran", fired.keyDown, 1);
  },
};

const disappearArrivalStopsBroadcasts: ContextEventOrderScenario = {
  name: "a disappear's arrival stops the broadcasts and the input, while its teardown is still waiting",
  async run({ adapter, emit }) {
    const press = gate();
    const { calls, handler } = record({ keyDown: press });
    const rule = "liveness ends at the willDisappear's arrival, not when its teardown runs";
    const fired = subscribeBroadcasts(adapter);

    adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    emit("willAppear", "ctx-1");
    await settle();
    emit("keyDown", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "keyDown"]);
    expectCount(rule, "the key-down broadcast for the press in flight", fired.keyDown, 1);

    // The teardown now waits behind the press in flight; input arriving meanwhile is for a context that is gone.
    emit("willDisappear", "ctx-1");
    emit("keyDown", "ctx-1");
    emit("keyDown", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "keyDown"]);
    expectCount(rule, "the key-down broadcast after the disappear arrived", fired.keyDown, 1);

    press.open();
    await settle();

    expectCalls(rule, calls, [
      "willAppear",
      "willAppear:done",
      "keyDown",
      "keyDown:done",
      "willDisappear",
      "willDisappear:done",
    ]);
    expectCount(rule, "the key-down broadcast after the teardown ran", fired.keyDown, 1);
  },
};

/**
 * The contract suite, in the order the spec lists its rules, then the checks
 * the review added. Run each against a fresh harness; every scenario throws on
 * the rule it checks and resolves otherwise.
 */
export const CONTEXT_EVENT_ORDER_SCENARIOS: readonly ContextEventOrderScenario[] = [
  slowAppearThenEarlyDisappear,
  noOvertaking,
  inputAfterDisappearIsDropped,
  inputBeforeAppearFollowsPolicy,
  twoInputsRunConcurrently,
  broadcastsFireForLiveContextsOnly,
  broadcastFiresAtArrival,
  disappearArrivalStopsBroadcasts,
  everyInputKindWaitsForLifecycle,
  settingsChangeIsExclusive,
  reappearWaitsForTeardown,
  lateAppearForLiveContext,
];
