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
 * deck-core's own test runs the list against reference adapters kept beside
 * it (`context-event-order-reference-adapters.test-support.ts`): one that calls
 * handlers at arrival and one that serialises everything, asserting scenario by
 * scenario which reference each fails on, so no scenario can pass vacuously.
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

/**
 * What a scenario may ask the host event to carry. Every field is optional and
 * the harness fills its host's defaults for the rest; a scenario that passes
 * none is driving the order, not the payload.
 */
export interface ContextEventOrderPayload {
  readonly settings?: Record<string, unknown>;
  /** `dialRotate` only. */
  readonly ticks?: number;
  /** `dialRotate` only. */
  readonly pressed?: boolean;
}

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
   * Deliver one host event for `context` **synchronously**, through the
   * adapter's real dispatch — a fake SDK emitting to the registered
   * `BridgeAction` on Elgato, the client's routed action event on Mirabox and
   * Ulanzi — exactly as the host would, and return without awaiting what the
   * dispatch started. The event is for {@link CONTEXT_EVENT_ORDER_ACTION_UUID}.
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

  const step = async (event: ContextHandlerEventKind, ev: IDeckEvent<unknown>): Promise<void> => {
    calls.push(event);

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

  return { calls, subscriptions, handler };
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

const inputAfterDisappearIsDropped: ContextEventOrderScenario = {
  name: "input after a disappear is dropped",
  async run({ adapter, emit }) {
    const { calls, handler } = record();
    const rule = "input for a context whose willDisappear has arrived never reaches the handler";

    adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    emit("willAppear", "ctx-1");
    await settle();
    emit("willDisappear", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "willDisappear", "willDisappear:done"]);

    emit("keyDown", "ctx-1");
    emit("keyUp", "ctx-1");
    emit("dialRotate", "ctx-1", { ticks: 1, pressed: false });
    emit("didReceiveSettings", "ctx-1");
    await settle();

    expectCalls(rule, calls, ["willAppear", "willAppear:done", "willDisappear", "willDisappear:done"]);
  },
};

const inputBeforeAppearIsDropped: ContextEventOrderScenario = {
  name: "input before any appear is dropped",
  async run({ adapter, emit }) {
    const { calls, handler } = record();
    const rule = "input for a context the host never sent a willAppear for never reaches the handler";

    adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);

    emit("keyDown", "ctx-1");
    emit("keyUp", "ctx-1");
    emit("dialRotate", "ctx-1", { ticks: 1, pressed: false });
    emit("didReceiveSettings", "ctx-1");
    emit("willDisappear", "ctx-1");
    await settle();

    expectCalls(rule, calls, []);
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

const broadcastsFireForLiveContextsOnly: ContextEventOrderScenario = {
  name: "broadcasts fire only for a live context",
  async run({ adapter, emit }) {
    const { handler } = record();
    const rule = "onKeyDown / onDialDown / onDialRotate fire at arrival, for a live context only";
    const fired = { keyDown: 0, dialDown: 0, dialRotate: 0 };

    adapter.registerAction(CONTEXT_EVENT_ORDER_ACTION_UUID, handler);
    adapter.onKeyDown(() => {
      fired.keyDown += 1;
    });
    adapter.onDialDown(() => {
      fired.dialDown += 1;
    });
    adapter.onDialRotate(() => {
      fired.dialRotate += 1;
    });

    const each = (): void => {
      emit("keyDown", "ctx-1");
      emit("dialDown", "ctx-1");
      emit("dialRotate", "ctx-1", { ticks: 1, pressed: false });
    };

    // Never appeared: nothing fires.
    each();
    await settle();

    expectCount(rule, "the key-down broadcast for a context that never appeared", fired.keyDown, 0);
    expectCount(rule, "the dial-down broadcast for a context that never appeared", fired.dialDown, 0);
    expectCount(rule, "the dial-rotate broadcast for a context that never appeared", fired.dialRotate, 0);

    // Live: each fires once per event.
    emit("willAppear", "ctx-1");
    await settle();
    each();
    await settle();

    expectCount(rule, "the key-down broadcast for a live context", fired.keyDown, 1);
    expectCount(rule, "the dial-down broadcast for a live context", fired.dialDown, 1);
    expectCount(rule, "the dial-rotate broadcast for a live context", fired.dialRotate, 1);

    // Disappeared: nothing more fires.
    emit("willDisappear", "ctx-1");
    await settle();
    each();
    await settle();

    expectCount(rule, "the key-down broadcast for a context that disappeared", fired.keyDown, 1);
    expectCount(rule, "the dial-down broadcast for a context that disappeared", fired.dialDown, 1);
    expectCount(rule, "the dial-rotate broadcast for a context that disappeared", fired.dialRotate, 1);
  },
};

/**
 * The contract suite, in the order the spec lists its rules. Run each against a
 * fresh harness; every scenario throws on the rule it checks and resolves
 * otherwise.
 */
export const CONTEXT_EVENT_ORDER_SCENARIOS: readonly ContextEventOrderScenario[] = [
  slowAppearThenEarlyDisappear,
  noOvertaking,
  inputAfterDisappearIsDropped,
  inputBeforeAppearIsDropped,
  twoInputsRunConcurrently,
  broadcastsFireForLiveContextsOnly,
];
