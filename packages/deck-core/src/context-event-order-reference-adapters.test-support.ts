/**
 * Reference adapters for the ordering contract suite's own test (#1597,
 * decision 6): the lasting positive controls. Each dispatches host events to
 * the registered handler the way a real adapter does, over a fake action
 * context, and differs only in what it orders:
 *
 * - {@link UnorderedReferenceAdapter} calls the handler at arrival and fires
 *   every broadcast, as every adapter did before #1597. Each ordering and
 *   liveness scenario must fail on it.
 * - {@link SerialReferenceAdapter} runs every event of a context one after
 *   another, and tracks liveness at arrival. The concurrency scenario must fail
 *   on it.
 * - {@link OrderedReferenceAdapter} routes every event through
 *   `ContextEventOrder`, as the real adapters do: the pattern an adapter's
 *   `registerAction` follows, and the proof that every scenario is passable.
 *
 * They implement {@link ContextEventOrderAdapter}, the slice of the platform
 * adapter the suite drives, not `IDeckPlatformAdapter` itself: declaring that
 * interface here would make deck-core an adapter package to
 * `scripts/deck-adapter-order-contract.test.mjs`. Test support only: not
 * exported from the barrel or the testing entry.
 */
import type { ILogger } from "@iracedeck/logger";

import type {
  ContextEventOrderAdapter,
  ContextEventOrderHarness,
  ContextEventOrderHostEvent,
  ContextEventOrderPayload,
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

/** A fake action context: an id, and every method a no-op. */
function fakeContext(id: string): IDeckActionContext {
  return {
    id,
    setImage: async () => undefined,
    setTitle: async () => undefined,
    setSettings: async () => undefined,
    isKey: () => true,
    isDial: () => false,
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
  payload: ContextEventOrderPayload,
): Promise<void> | void {
  const base: IDeckEvent<unknown> = { action: fakeContext(context), payload: { settings: payload.settings ?? {} } };

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

/** The registration and broadcast bookkeeping the three references share. */
abstract class ReferenceAdapter implements ContextEventOrderAdapter {
  protected readonly handlers = new Map<string, IDeckActionHandler>();
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

  /** The harness the suite runs over this adapter. Events go to every registered handler, as a host routes by UUID. */
  harness(): ContextEventOrderHarness {
    return {
      adapter: this,
      emit: (event, context, payload = {}) => {
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
    void dispatch(handler, event, context, payload);
  }
}

/** Strict FIFO per context, liveness at arrival: everything in order, input included. */
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

    const tail = this.tails.get(context) ?? Promise.resolve();
    const next = tail.then(() => dispatch(handler, event, context, payload)).catch(() => undefined);

    this.tails.set(context, next);
  }
}

/** The pattern a real adapter follows: broadcasts behind `isLive`, every handler call through `enqueue`. */
export class OrderedReferenceAdapter extends ReferenceAdapter {
  private readonly order = new ContextEventOrder(silentLogger);

  protected emit(
    handler: IDeckActionHandler,
    event: ContextEventOrderHostEvent,
    context: string,
    payload: ContextEventOrderPayload,
  ): void {
    if (this.order.isLive(context)) this.broadcast(event);

    void this.order.enqueue(context, event, () => dispatch(handler, event, context, payload));
  }
}
