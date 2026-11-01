/**
 * The triggers on their own (issue #1514): a fake bus that records its
 * subscriptions and lets a test publish, a spy standing in for the
 * scheduler's `attemptFire`, and fake timers — the immediate path, the
 * `triggerDelay`, the `settle` polls and their deadline, a `where` that
 * throws on each path, and what `attach` / `detach` / `cancelPending` /
 * `detachAll` do to a contract's two trigger fields.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContract } from "./dsl.js";
import { DEFAULT_FRAME } from "./dsl.js";
import type { CompiledScenario } from "./engine-types.js";
import { Triggers } from "./triggers.js";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
} as unknown as ILogger;

const logged = (level: "debug" | "info" | "warn" | "error"): string[] =>
  vi.mocked(logger[level]).mock.calls.map(([line]) => String(line));

type Handler = (e: SimEventOf<SimEventName>) => void;

type Harness = {
  triggers: Triggers;
  contracts: Map<string, CompiledScenario>;
  /** Every `attemptFire` the triggers made: the entry and the event. */
  fired: Array<[CompiledScenario, SimEventOf<SimEventName> | null]>;
  /** The live handlers per event, in subscription order. */
  handlers: Map<SimEventName, Handler[]>;
  define(c: Omit<ScenarioContract, "bus" | "channel">): CompiledScenario;
  /** Register and attach in one go, as the facade's registration does. */
  attach(c: Omit<ScenarioContract, "bus" | "channel">): CompiledScenario;
  publish(event: SimEventName, data?: unknown): SimEventOf<SimEventName>;
};

function harness(): Harness {
  const contracts = new Map<string, CompiledScenario>();
  const fired: Harness["fired"] = [];
  const handlers = new Map<SimEventName, Handler[]>();
  const bus = {
    subscribe: (event: SimEventName, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);

      return () => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((h) => h !== handler),
        );
      };
    },
  } as unknown as IEventBus;
  const h: Harness = {
    triggers: new Triggers(bus, logger, {
      contracts: { get: (id) => contracts.get(id), entries: contracts },
      scheduler: {
        attemptFire: (entry, event) => {
          fired.push([entry, event]);
        },
      },
    }),
    contracts,
    fired,
    handlers,
    define(c) {
      const raw: ScenarioContract = { bus: AudioBus.Voice, channel: AudioChannel.Voice, ...c };
      const entry: CompiledScenario = {
        raw,
        resolvedSequence: null,
        frame: raw.frame ?? DEFAULT_FRAME,
        enabled: true,
        unsubscribe: null,
        lastFireAt: 0,
        pendingTriggerTimer: null,
      };
      contracts.set(raw.id, entry);

      return entry;
    },
    attach(c) {
      const entry = h.define(c);
      h.triggers.attach(entry);

      return entry;
    },
    publish(event, data) {
      const ev = { event, timestamp: Date.now(), telemetry: null, data } as unknown as SimEventOf<SimEventName>;

      for (const handler of [...(handlers.get(event) ?? [])]) handler(ev);

      return ev;
    },
  };

  return h;
}

const EVENT: SimEventName = "pitLane.entered";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── attach / detach ─────────────────────────────────────────────────────────

describe("attach and detach", () => {
  it("subscribes a contract with `when` and records the unsubscribe on the entry; one without `when` subscribes nothing", () => {
    const h = harness();

    const a = h.attach({ id: "a", when: { event: EVENT } });
    const b = h.attach({ id: "b" });

    expect(h.handlers.get(EVENT)).toHaveLength(1);
    expect(a.unsubscribe).toBeTypeOf("function");
    expect(b.unsubscribe).toBeNull();
  });

  it("`detach` unsubscribes and clears the entry's handle, and is a no-op on a contract with none", () => {
    const h = harness();
    const a = h.attach({ id: "a", when: { event: EVENT } });
    const b = h.attach({ id: "b" });

    h.triggers.detach(a);
    h.triggers.detach(b);

    expect(h.handlers.get(EVENT)).toHaveLength(0);
    expect(a.unsubscribe).toBeNull();
    h.publish(EVENT);
    expect(h.fired).toEqual([]);
  });

  it("a redefinition's new subscription goes to the end of the event's dispatch list", () => {
    const h = harness();
    const a = h.attach({ id: "a", when: { event: EVENT } });
    h.attach({ id: "b", when: { event: EVENT } });

    h.triggers.detach(a);
    h.attach({ id: "a", when: { event: EVENT } });
    h.publish(EVENT);

    expect(h.fired.map(([entry]) => entry.raw.id)).toEqual(["b", "a"]);
  });

  it("`detachAll` unsubscribes every contract and cancels every pending timer", () => {
    const h = harness();
    const a = h.attach({ id: "a", when: { event: EVENT }, triggerDelay: 200 });
    const b = h.attach({ id: "b", when: { event: EVENT } });
    h.publish(EVENT);
    expect(a.pendingTriggerTimer).not.toBeNull();

    h.triggers.detachAll();
    vi.advanceTimersByTime(200);

    expect(a.pendingTriggerTimer).toBeNull();
    expect(a.unsubscribe).toBeNull();
    expect(b.unsubscribe).toBeNull();
    expect(h.handlers.get(EVENT)).toHaveLength(0);
    // `b` fired at the publish; `a`'s timer never did.
    expect(h.fired.map(([entry]) => entry.raw.id)).toEqual(["b"]);
  });
});

// ─── the immediate path ──────────────────────────────────────────────────────

describe("the immediate path", () => {
  it("fires synchronously with the entry and the event when `where` passes or is absent", () => {
    const h = harness();
    const a = h.attach({ id: "a", when: { event: EVENT } });
    const b = h.attach({ id: "b", when: { event: EVENT, where: (e) => (e.data as unknown) === "yes" } });

    const ev = h.publish(EVENT, "yes");

    expect(h.fired).toEqual([
      [a, ev],
      [b, ev],
    ]);
    expect(a.pendingTriggerTimer).toBeNull();
  });

  it("does nothing when `where` refuses, and nothing for a disabled or removed contract", () => {
    const h = harness();
    h.attach({ id: "refused", when: { event: EVENT, where: () => false } });
    const disabled = h.attach({ id: "disabled", when: { event: EVENT } });
    disabled.enabled = false;
    h.attach({ id: "removed", when: { event: EVENT } });
    h.contracts.delete("removed");

    h.publish(EVENT);

    expect(h.fired).toEqual([]);
  });

  it("a `where` that throws is logged at error and fires nothing", () => {
    const h = harness();
    h.attach({
      id: "a",
      when: {
        event: EVENT,
        where: () => {
          throw new Error("boom");
        },
      },
    });

    h.publish(EVENT);

    expect(h.fired).toEqual([]);
    expect(logged("error")).toEqual(['Scenario "a" where() threw: boom']);
  });
});

// ─── the delay ───────────────────────────────────────────────────────────────

describe("the trigger delay", () => {
  it("fires after `triggerDelay`, with `where` asked at expiry, not at arrival", () => {
    const h = harness();
    let answer = false;
    const a = h.attach({ id: "a", when: { event: EVENT, where: () => answer }, triggerDelay: 200 });

    const ev = h.publish(EVENT);
    expect(a.pendingTriggerTimer).not.toBeNull();
    answer = true;

    vi.advanceTimersByTime(199);
    expect(h.fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.fired).toEqual([[a, ev]]);
    expect(a.pendingTriggerTimer).toBeNull();
  });

  it("a newer event within the delay replaces the pending one: the most recent wins, once", () => {
    const h = harness();
    const a = h.attach({ id: "a", when: { event: EVENT }, triggerDelay: 200 });

    h.publish(EVENT, 1);
    vi.advanceTimersByTime(150);
    const second = h.publish(EVENT, 2);
    vi.advanceTimersByTime(150);
    expect(h.fired).toEqual([]);
    vi.advanceTimersByTime(50);

    expect(h.fired).toEqual([[a, second]]);
  });

  it("`cancelPending` says whether a timer was pending, and a cancelled timer never fires", () => {
    const h = harness();
    const a = h.attach({ id: "a", when: { event: EVENT }, triggerDelay: 200 });

    expect(h.triggers.cancelPending(a)).toBe(false);
    h.publish(EVENT);
    expect(h.triggers.cancelPending(a)).toBe(true);
    expect(a.pendingTriggerTimer).toBeNull();
    expect(h.triggers.cancelPending(a)).toBe(false);
    vi.advanceTimersByTime(200);

    expect(h.fired).toEqual([]);
  });

  it("a contract disabled or redefined during the wait fires nothing at expiry", () => {
    const h = harness();
    const disabled = h.attach({ id: "disabled", when: { event: EVENT }, triggerDelay: 200 });
    const old = h.attach({ id: "redefined", when: { event: EVENT }, triggerDelay: 200 });

    h.publish(EVENT);
    disabled.enabled = false;
    // The facade's redefinition: the old entry is detached and a new one stored.
    h.triggers.detach(old);
    h.triggers.cancelPending(old);
    h.attach({ id: "redefined", when: { event: EVENT }, triggerDelay: 200 });
    vi.advanceTimersByTime(200);

    expect(h.fired).toEqual([]);
  });

  it("a `where` that throws at expiry is logged as deferred and fires nothing", () => {
    const h = harness();
    h.attach({
      id: "a",
      when: {
        event: EVENT,
        where: () => {
          throw new Error("boom");
        },
      },
      triggerDelay: 200,
    });

    h.publish(EVENT);
    vi.advanceTimersByTime(200);

    expect(h.fired).toEqual([]);
    expect(logged("error")).toEqual(['Scenario "a" where() threw (deferred): boom']);
  });
});

// ─── settle ──────────────────────────────────────────────────────────────────

describe("settle", () => {
  const settle = (pending: (ctx: { event: unknown }) => string | null, maxWaitMs = 1000, pollMs = 100) => ({
    pending: pending as unknown as NonNullable<ScenarioContract["settle"]>["pending"],
    maxWaitMs,
    pollMs,
  });

  it("asks at once (no `triggerDelay`), then every `pollMs` until ready, and says how long it took", () => {
    const h = harness();
    let asks = 0;
    const a = h.attach({ id: "a", when: { event: EVENT }, settle: settle(() => (++asks < 3 ? "wetness" : null)) });

    const ev = h.publish(EVENT);
    vi.advanceTimersByTime(0);
    expect(asks).toBe(1);
    expect(h.fired).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(asks).toBe(2);
    vi.advanceTimersByTime(100);

    expect(asks).toBe(3);
    expect(h.fired).toEqual([[a, ev]]);
    expect(a.pendingTriggerTimer).toBeNull();
    expect(logged("debug")).toEqual(['Scenario "a" settled after 200 ms']);
  });

  it("a check ready at the first ask logs nothing", () => {
    const h = harness();
    h.attach({ id: "a", when: { event: EVENT }, settle: settle(() => null) });

    h.publish(EVENT);
    vi.advanceTimersByTime(0);

    expect(h.fired).toHaveLength(1);
    expect(logged("debug")).toEqual([]);
  });

  it("the polls run from the event's arrival, after the `triggerDelay`, and the last lands AT `maxWaitMs`", () => {
    const h = harness();
    const askedAt: number[] = [];
    const a = h.attach({
      id: "a",
      when: { event: EVENT },
      triggerDelay: 250,
      settle: settle(
        () => {
          askedAt.push(Date.now());

          return "wetness";
        },
        500,
        100,
      ),
    });
    vi.setSystemTime(10_000);

    const ev = h.publish(EVENT);
    vi.advanceTimersByTime(500);

    expect(askedAt.map((t) => t - 10_000)).toEqual([250, 350, 450, 500]);
    expect(h.fired).toEqual([[a, ev]]);
    expect(logged("info")).toEqual(['Scenario "a" proceeding without wetness after 500 ms']);
  });

  it("`where` is asked after the settle, and refuses the fire as on the delay path", () => {
    const h = harness();
    const order: string[] = [];
    h.attach({
      id: "a",
      when: {
        event: EVENT,
        where: () => {
          order.push("where");

          return false;
        },
      },
      settle: settle(() => {
        order.push("pending");

        return null;
      }),
    });

    h.publish(EVENT);
    vi.advanceTimersByTime(0);

    expect(order).toEqual(["pending", "where"]);
    expect(h.fired).toEqual([]);
  });

  it("a check that throws is logged at error and read as ready", () => {
    const h = harness();
    h.attach({
      id: "a",
      when: { event: EVENT },
      settle: settle(() => {
        throw new Error("boom");
      }),
    });

    h.publish(EVENT);
    vi.advanceTimersByTime(0);

    expect(h.fired).toHaveLength(1);
    expect(logged("error")).toEqual(['Scenario "a" settle.pending() threw; proceeding as ready: boom']);
  });

  it("`cancelPending` mid-settle cancels the wait, and a newer event restarts it", () => {
    const h = harness();
    let asks = 0;
    const a = h.attach({
      id: "a",
      when: { event: EVENT },
      settle: settle(
        () => {
          asks++;

          return "wetness";
        },
        1000,
        100,
      ),
    });

    h.publish(EVENT);
    vi.advanceTimersByTime(250);
    expect(asks).toBe(3);
    expect(h.triggers.cancelPending(a)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(asks).toBe(3);
    expect(h.fired).toEqual([]);

    const second = h.publish(EVENT);
    vi.advanceTimersByTime(1000);

    expect(h.fired).toEqual([[a, second]]);
  });
});
