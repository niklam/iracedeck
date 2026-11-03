/**
 * Reference adapters for the ordering contract suite's own test (#1597,
 * decision 6): the lasting positive controls. Each dispatches host events to
 * the registered handler the way a real adapter does, over a fake action
 * context, and differs only in what it orders and when it decides:
 *
 * - {@link UnorderedReferenceAdapter} calls the handler at arrival and fires
 *   every broadcast, as every adapter did before #1597. Each ordering and
 *   liveness scenario must fail on it.
 * - {@link SerialReferenceAdapter} runs every event of a context one after
 *   another, with liveness and broadcasts decided at arrival. The concurrency
 *   scenario must fail on it.
 * - {@link InTaskBroadcastReferenceAdapter} is the serial one with its
 *   broadcasts fired when the task runs instead of at arrival. The
 *   broadcast-at-arrival scenario must fail on it.
 * - {@link InTaskLivenessReferenceAdapter} is the serial one with liveness
 *   ended by the disappear task — set at the appear's arrival but cleared
 *   only after the disappear handler has run, the shape the adapters had —
 *   and read at arrival. The disappear-arrival scenario must fail on it.
 * - {@link OrderedReferenceAdapter} routes every event through
 *   `ContextEventOrder`, as the real adapters do, and delivers a host appear
 *   for a live context as a settings change: the pattern an adapter's
 *   `registerAction` follows, and the proof that every scenario is passable.
 * - {@link LateAppearDropReferenceAdapter} is the ordered one without that
 *   rule, letting the order drop the host's late appear. The late-appear
 *   scenario must fail on it.
 *
 * They implement {@link ContextEventOrderAdapter}, the slice of the platform
 * adapter the suite drives, not `IDeckPlatformAdapter` itself: declaring that
 * interface here would make deck-core an adapter package to
 * `scripts/deck-adapter-order-contract.test.mjs`. Test support only: not
 * exported from the barrel or the testing entry.
 */
import type { ILogger } from "@iracedeck/logger";

import {
  CONTEXT_EVENT_ORDER_HOST_EVENTS,
  type ContextEventOrderAdapter,
  type ContextEventOrderHarness,
  type ContextEventOrderHostEvent,
  type ContextEventOrderPayload,
} from "./context-event-order-scenarios.js";
import { ContextEventOrder } from "./context-event-order.js";
import type { IDeckActionContext, IDeckActionHandler, IDeckDialRotateEvent, IDeckEvent } from "./types.js";

const silentLogger: ILogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  withLevel: () => silentLogger,
  createScope: () => silentLogger,
};

type Controller = "Keypad" | "Encoder";

/** A fake action context: an id, the controller it appeared as, and every method a no-op. */
function fakeContext(id: string, controller: Controller): IDeckActionContext {
  return {
    id,
    setImage: async () => undefined,
    setTitle: async () => undefined,
    setSettings: async () => undefined,
    isKey: () => controller === "Keypad",
    isDial: () => controller === "Encoder",
    setFeedback: async () => undefined,
    setFeedbackLayout: async () => undefined,
    setTriggerDescription: async () => undefined,
    dialCanvas: () => null,
    setDialCanvas: async () => undefined,
  };
}

/** Call the handler method `event` names with a deck-core event built now, as an adapter's task does. */
function dispatch(
  handler: IDeckActionHandler,
  event: ContextEventOrderHostEvent,
  context: string,
  controller: Controller,
  payload: ContextEventOrderPayload,
): Promise<void> | void {
  const base: IDeckEvent<unknown> = {
    action: fakeContext(context, controller),
    payload: { settings: payload.settings ?? {} },
  };

  switch (event) {
    case "willAppear":
      return handler.onWillAppear?.(base);
    case "willDisappear":
      return handler.onWillDisappear?.(base);
    case "didReceiveSettings":
      return handler.onDidReceiveSettings?.(base);
    case "keyDown":
      return handler.onKeyDown?.(base);
    case "keyUp":
      return handler.onKeyUp?.(base);
    case "dialDown":
      return handler.onDialDown?.(base);
    case "dialUp":
      return handler.onDialUp?.(base);
    case "dialRotate": {
      const rotate: IDeckDialRotateEvent<unknown> = {
        action: base.action,
        payload: { settings: base.payload.settings, ticks: payload.ticks ?? 1, pressed: payload.pressed ?? false },
      };

      return handler.onDialRotate?.(rotate);
    }
    case "touchTap":
      return handler.onTouchTap?.({ action: base.action, payload: { ...base.payload, tapPos: [0, 0], hold: false } });
  }
}

/** The registration, controller and broadcast bookkeeping the references share. */
abstract class ReferenceAdapter implements ContextEventOrderAdapter {
  protected readonly handlers = new Map<string, IDeckActionHandler>();
  protected readonly controllers = new Map<string, Controller>();
  protected readonly keyDownCallbacks: Array<() => void> = [];
  protected readonly dialDownCallbacks: Array<() => void> = [];
  protected readonly dialRotateCallbacks: Array<() => void> = [];

  registerAction(uuid: string, handler: IDeckActionHandler): void {
    this.handlers.set(uuid, handler);
  }

  onKeyDown(callback: () => void): void {
    this.keyDownCallbacks.push(callback);
  }

  onDialDown(callback: () => void): void {
    this.dialDownCallbacks.push(callback);
  }

  onDialRotate(callback: () => void): void {
    this.dialRotateCallbacks.push(callback);
  }

  /** The harness the suite runs over this adapter: every host event, events to every registered handler. */
  harness(): ContextEventOrderHarness {
    return {
      adapter: this,
      hostEvents: CONTEXT_EVENT_ORDER_HOST_EVENTS,
      emit: (event, context, payload = {}) => {
        if (event === "willAppear" && payload.controller !== undefined) {
          this.controllers.set(context, payload.controller);
        }

        for (const handler of this.handlers.values()) this.emit(handler, event, context, payload);
      },
    };
  }

  protected broadcast(event: ContextEventOrderHostEvent): void {
    const callbacks =
      event === "keyDown"
        ? this.keyDownCallbacks
        : event === "dialDown"
          ? this.dialDownCallbacks
          : event === "dialRotate"
            ? this.dialRotateCallbacks
            : [];

    for (const callback of callbacks) callback();
  }

  /** The handler call for one host event, built when called, as a task does. */
  protected call(
    handler: IDeckActionHandler,
    event: ContextEventOrderHostEvent,
    context: string,
    payload: ContextEventOrderPayload,
  ): Promise<void> | void {
    return dispatch(handler, event, context, this.controllers.get(context) ?? "Keypad", payload);
  }

  /** One host event at arrival, synchronous: what each reference does with it is the difference between them. */
  protected abstract emit(
    handler: IDeckActionHandler,
    event: ContextEventOrderHostEvent,
    context: string,
    payload: ContextEventOrderPayload,
  ): void;
}

/** Every adapter before #1597: the handler is called at arrival, and every broadcast fires. */
export class UnorderedReferenceAdapter extends ReferenceAdapter {
  protected emit(
    handler: IDeckActionHandler,
    event: ContextEventOrderHostEvent,
    context: string,
    payload: ContextEventOrderPayload,
  ): void {
    this.broadcast(event);
    void this.call(handler, event, context, payload);
  }
}

/** Strict FIFO per context; liveness, drops and broadcasts at arrival. */
export class SerialReferenceAdapter extends ReferenceAdapter {
  private readonly live = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();

  protected emit(
    handler: IDeckActionHandler,
    event: ContextEventOrderHostEvent,
    context: string,
    payload: ContextEventOrderPayload,
  ): void {
    if (event === "willAppear") {
      this.live.add(context);
    } else if (!this.live.has(context)) {
      return;
    } else if (event === "willDisappear") {
      this.live.delete(context);
    }

    this.broadcast(event);
    this.chain(context, () => this.call(handler, event, context, payload));
  }

  protected chain(context: string, task: () => Promise<void> | void): void {
    const tail = this.tails.get(context) ?? Promise.resolve();

    this.tails.set(
      context,
      tail.then(task).catch(() => undefined),
    );
  }
}

/** The serial reference, with its broadcasts fired when the task runs rather than at arrival. */
export class InTaskBroadcastReferenceAdapter extends SerialReferenceAdapter {
  private readonly liveAtArrival = new Set<string>();

  protected override emit(
    handler: IDeckActionHandler,
    event: ContextEventOrderHostEvent,
    context: string,
    payload: ContextEventOrderPayload,
  ): void {
    if (event === "willAppear") {
      this.liveAtArrival.add(context);
    } else if (!this.liveAtArrival.has(context)) {
      return;
    } else if (event === "willDisappear") {
      this.liveAtArrival.delete(context);
    }

    this.chain(context, () => {
      this.broadcast(event);

      return this.call(handler, event, context, payload);
    });
  }
}

/**
 * The serial reference, with liveness ended by the disappear task — set at the
 * appear's arrival, as the adapters set their controller entry, but cleared
 * only once the disappear handler has run, as they deleted it — and read at
 * arrival for the drop decision and the broadcast.
 */
export class InTaskLivenessReferenceAdapter extends SerialReferenceAdapter {
  private readonly liveUntilTeardown = new Set<string>();

  protected override emit(
    handler: IDeckActionHandler,
    event: ContextEventOrderHostEvent,
    context: string,
    payload: ContextEventOrderPayload,
  ): void {
    if (event === "willAppear") {
      this.liveUntilTeardown.add(context);
    } else if (!this.liveUntilTeardown.has(context)) {
      return;
    }

    this.broadcast(event);
    this.chain(context, async () => {
      await this.call(handler, event, context, payload);

      if (event === "willDisappear") this.liveUntilTeardown.delete(context);
    });
  }
}

/**
 * The pattern a real adapter follows: broadcasts behind `isLive`, every handler
 * call through `enqueue`, and a host `willAppear` for a live context delivered
 * as a settings change.
 */
export class OrderedReferenceAdapter extends ReferenceAdapter {
  protected readonly order = new ContextEventOrder(silentLogger);

  protected emit(
    handler: IDeckActionHandler,
    event: ContextEventOrderHostEvent,
    context: string,
    payload: ContextEventOrderPayload,
  ): void {
    if (this.order.isLive(context)) this.broadcast(event);

    // A host appear for a context that is already live is a settings change,
    // not a second appear: converted at arrival, so the order's own drop of a
    // live willAppear (frame settings included) is a safety net never reached.
    if (event === "willAppear" && this.order.isLive(context)) {
      void this.order.enqueue(context, "didReceiveSettings", () =>
        this.call(handler, "didReceiveSettings", context, payload),
      );

      return;
    }

    // Discarded on purpose: the harness's `emit` returns nothing, and a
    // discarded result is safe (never an unhandled rejection) but silent.
    void this.order.enqueue(context, event, () => this.call(handler, event, context, payload));
  }
}

/**
 * The ordered reference without the live-appear rule: a host `willAppear` for
 * a context that is already live reaches the order unconverted and is dropped
 * there, frame settings included. The late-appear scenario must fail on it.
 */
export class LateAppearDropReferenceAdapter extends OrderedReferenceAdapter {
  protected override emit(
    handler: IDeckActionHandler,
    event: ContextEventOrderHostEvent,
    context: string,
    payload: ContextEventOrderPayload,
  ): void {
    if (this.order.isLive(context)) this.broadcast(event);

    void this.order.enqueue(context, event, () => this.call(handler, event, context, payload));
  }
}
