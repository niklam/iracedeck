/**
 * Playback (issue #1514): a fire's expanded ops walked one step at a time,
 * driving `@iracedeck/audio-service`. It is the only module that calls
 * `IAudioService`, and the only writer of a playing fire's transport fields
 * (`index`, `cancelled`, `pauseTimer`, `usedChannels`, `onSettled`): whoever
 * starts a fire passes its scheduling fields (`FireStart`), and playback
 * fills in the rest.
 *
 * It decides nothing about WHETHER a fire plays — no gate, no weight, no
 * queue — and sees no bus's schedule (`TransportTable`). What arbitration
 * needs to hear reaches it through the `PlaybackListener` it is constructed
 * with: `busTaken` when a fire takes a bus, `fireFinished` when one runs off
 * the end of its ops. Both are called synchronously, inside playback's own
 * call stack — the scheduler is re-entered from a failed `playOnChannel`, a
 * channel-complete callback, or a `stopChannel` that completes at once — so
 * a fire being cut is marked `cancelled` BEFORE any of its channels stops. A
 * cut (`cancelActiveFire`) reports nothing: its callers drain explicitly.
 */
import type { AudioBus, IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { ILogger } from "@iracedeck/logger";

import type { ActiveFire, ExecOp, TransportTable } from "./engine-types.js";
import type { PoolStore } from "./pool-store.js";

/**
 * What playback reports to arbitration, synchronously and never deferred:
 * the scheduler runs inside playback's call stack (see the module comment),
 * and what it does there — clear a hold, arm one, drain the queue — must
 * have happened by the time the step that caused it returns.
 */
export type PlaybackListener = {
  /**
   * A fire took `bus` (`takeBus`). A pending hold armed at the previous
   * fire's finish is obsolete; it re-arms when this fire finishes.
   */
  busTaken(bus: AudioBus): void;
  /**
   * The fire `id` ran off the end of its ops and left `bus`: it is no longer
   * the active fire and its `onSettled` has run. The scheduler holds the
   * drain for the contract's `pendingHoldMs`, else drains.
   */
  fireFinished(bus: AudioBus, id: string): void;
};

/**
 * What whoever starts a fire passes to `takeBus`: the scheduling fields of
 * an `ActiveFire`, the resume mapping included (`sourceOps`, `sourceStart`,
 * `prerollCount`), and `onSettled` when the caller must hear the fire leave
 * the bus. Playback fills in the transport fields.
 */
export type FireStart = Pick<
  ActiveFire,
  | "id"
  | "bus"
  | "weight"
  | "ops"
  | "sourceOps"
  | "sourceStart"
  | "prerollCount"
  | "event"
  | "sessionGeneration"
  | "cutTail"
  | "ended"
  | "onSettled"
>;

/** What playback reads of the other modules — only the members it uses. */
export type PlaybackDeps = {
  /** The live manifest, for the ambient loop (`setManifest` swaps it). */
  pools: Pick<PoolStore, "currentManifest">;
};

export class Playback {
  constructor(
    private readonly audio: IAudioService,
    private readonly logger: ILogger,
    private readonly buses: TransportTable,
    private readonly listener: PlaybackListener,
    private readonly deps: PlaybackDeps,
  ) {}

  /**
   * Put a fire on the bus and record it as the one playing. A pending hold
   * armed at the previous fire's finish is obsolete (`busTaken`); it re-arms
   * when this fire finishes. The caller starts it with `stepNext`.
   */
  takeBus(start: FireStart): void {
    const state = this.buses.get(start.bus);
    this.listener.busTaken(start.bus);
    state.transport.active = {
      id: start.id,
      bus: start.bus,
      weight: start.weight,
      ops: start.ops,
      index: 0,
      sourceOps: start.sourceOps,
      sourceStart: start.sourceStart,
      prerollCount: start.prerollCount,
      cancelled: false,
      pauseTimer: null,
      usedChannels: collectUsedChannels(start.ops),
      event: start.event,
      sessionGeneration: start.sessionGeneration,
      cutTail: start.cutTail,
      ended: start.ended,
      onSettled: start.onSettled,
    };
  }

  /** Advance to the next op in the given bus's active fire. */
  stepNext(bus: AudioBus): void {
    const state = this.buses.get(bus);
    const fire = state.transport.active;

    if (!fire || fire.cancelled) return;

    if (fire.index >= fire.ops.length) {
      this.finishFire(fire.id, fire.bus);

      return;
    }

    const op = fire.ops[fire.index];
    fire.index++;

    try {
      if (op.kind === "play") {
        this.audio.onChannelComplete(op.channel, () => {
          if (state.transport.active === fire && !fire.cancelled) this.stepNext(bus);
        });
        const ok = this.audio.playOnChannel(op.channel, op.path);

        if (!ok) {
          this.logger.warn(`Failed to play ${op.path} on channel ${op.channel}; advancing`);
          this.stepNext(bus);
        }

        return;
      }

      if (op.kind === "ambient") {
        if (op.action === "start")
          this.audio.playOnChannel(AudioChannel.Ambient, this.deps.pools.currentManifest().ambientLoop, true);
        else if (op.action === "stop") this.audio.stopChannel(AudioChannel.Ambient);
        else if (op.action === "seek") this.audio.seekChannelRandom(AudioChannel.Ambient);

        this.stepNext(bus);

        return;
      }

      if (op.kind === "pause") {
        if (op.ms <= 0) {
          this.stepNext(bus);

          return;
        }

        fire.pauseTimer = setTimeout(() => {
          fire.pauseTimer = null;

          if (state.transport.active === fire && !fire.cancelled) this.stepNext(bus);
        }, op.ms);

        return;
      }
    } catch (err) {
      this.logger.error(`Scenario "${fire.id}" step threw: ${err instanceof Error ? err.message : String(err)}`);
      this.stepNext(bus);
    }
  }

  /**
   * A fire ran off the end of its ops: take it off the bus, run its
   * `onSettled`, then tell the scheduler (`fireFinished`), which holds or
   * drains — in that order, so a caller's completion callback sees the bus
   * idle and runs before whatever the scheduler starts next.
   */
  private finishFire(scenarioId: string, bus: AudioBus): void {
    const state = this.buses.get(bus);

    if (state.transport.active?.id === scenarioId) {
      const finished = state.transport.active;
      state.transport.active = null;
      this.settle(finished);
    }

    this.listener.fireFinished(bus, scenarioId);
  }

  /**
   * Cancel the currently-executing fire on the given bus. Stops only the
   * channels the fire actually referenced (from its expanded ops), so
   * scenarios running on other buses aren't disturbed. Reports nothing: the
   * callers that need the bus drained afterwards drain it themselves.
   */
  cancelActiveFire(bus: AudioBus): void {
    const state = this.buses.get(bus);
    const fire = state.transport.active;

    if (!fire) return;

    fire.cancelled = true;

    if (fire.pauseTimer) {
      clearTimeout(fire.pauseTimer);
      fire.pauseTimer = null;
    }

    for (const channel of fire.usedChannels) this.audio.stopChannel(channel);

    state.transport.active = null;
    this.settle(fire);
  }

  /**
   * Cut the bus's playing fire mid-clip and put its cut tail on the bus in
   * its place (issue #1407), as a fire of its own marked `ended`: it holds
   * the bus until the tail finishes and then drains it like any fire, a
   * same-family or heavier `interrupt` arrival may cut it, and nothing
   * stashes it. A bus with no active fire is left alone — the caller has
   * already read the fire it means to end.
   *
   * The old fire is marked `cancelled` BEFORE its channels stop: `stopChannel`
   * may fire the body clip's complete callback, and that guard is what keeps
   * `stepNext` from moving the cut fire into its next body op. It is not
   * `cancelActiveFire`, which would release the bus and drop the `onSettled`
   * a caller waits on; the tail inherits both instead.
   *
   * The radio's ambience bed is left running when the tail stops it itself —
   * both first-party cuts are "never mind", then the bed stops with the close
   * tick, and a frame without `cut` falls back to its `close`, which carries
   * the same stop — so "never mind" is said over the bed rather than into
   * silence. A tail with no ambience stop has the bed stopped at the cut, as
   * before: nothing else would ever stop the loop.
   */
  playCutTail(bus: AudioBus): void {
    const fire = this.buses.get(bus).transport.active;

    if (!fire) return;

    fire.cancelled = true;

    if (fire.pauseTimer) {
      clearTimeout(fire.pauseTimer);
      fire.pauseTimer = null;
    }

    const tail = fire.cutTail;
    const tailStopsBed = tail.some((op) => op.kind === "ambient" && op.action === "stop");

    for (const channel of fire.usedChannels) {
      if (channel === AudioChannel.Ambient && tailStopsBed) continue;

      this.audio.stopChannel(channel);
    }

    this.takeBus({
      id: fire.id,
      bus: fire.bus,
      weight: fire.weight,
      ops: tail,
      sourceOps: tail,
      sourceStart: 0,
      prerollCount: 0,
      event: fire.event,
      sessionGeneration: fire.sessionGeneration,
      cutTail: [],
      ended: true,
      onSettled: fire.onSettled,
    });

    this.stepNext(bus);
  }

  /**
   * Run a fire's `onSettled` once it has left the bus, finished or cut. A
   * callback that throws is logged and swallowed: it is the caller's
   * cleanup, and the scheduler step that ran it must still complete.
   */
  private settle(fire: ActiveFire): void {
    const onSettled = fire.onSettled;

    if (onSettled === undefined) return;

    fire.onSettled = undefined;

    try {
      onSettled();
    } catch (err) {
      this.logger.error(`"${fire.id}" completion callback threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** One op as the `Ops (…)` debug line shows it: its frame tag, kind, channel and clip, and the pool it was drawn from. */
export function opLabel(op: ExecOp): string {
  const tag = op.frame === undefined ? "" : `${op.frame}:`;

  // The pool a take came from is what the resume compares (issue #1136), so a
  // debug line that shows the ops shows it beside the take it drew.
  if (op.kind === "play") return `${tag}play[${op.channel}] ${op.path}${op.pool === undefined ? "" : ` (${op.pool})`}`;

  if (op.kind === "ambient") return `${tag}ambient:${op.action}`;

  return `${tag}pause:${op.ms}`;
}

/**
 * Scan the expanded op list for every `AudioChannel` the fire will touch.
 * Cancellation uses this set so we stop exactly the channels this fire can
 * play on, no more and no less.
 */
function collectUsedChannels(ops: readonly ExecOp[]): ReadonlySet<AudioChannel> {
  const channels = new Set<AudioChannel>();

  for (const op of ops) {
    if (op.kind === "play") channels.add(op.channel);
    else if (op.kind === "ambient") channels.add(AudioChannel.Ambient);
  }

  return channels;
}
