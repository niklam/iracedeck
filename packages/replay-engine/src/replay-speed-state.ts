/**
 * The one record of the replay speed (#1316, #1467, #1427). Designs:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`, and
 * Decision 4 of `docs/superpowers/specs/2026-10-20-issue-1467-replay-engine-package.md`.
 *
 * iRacing has one replay speed, so everything here is ONE module-wide value,
 * never per dial or per key. The replay command gate records every speed it
 * actually sends ({@link recordReplaySpeedSent}), whichever surface asked, and
 * the engine's own tick feed (`replay-speed-feed.ts`) hands it every telemetry
 * tick that is in a replay ({@link noteTelemetrySpeed}). Two things are kept,
 * and they are separate concerns:
 *
 * - The **pending speed** (#1427: the one there is): a speed just sent that
 *   telemetry does not show yet. `ReplayPlaySpeed` reports a new speed only on
 *   a later tick, so a second detent or key press arriving first would walk
 *   from the old speed and send the same stop again, a jump pressed right
 *   after a speed key would remember the old speed, and the gate would take a
 *   replay that is starting to play for a paused one. Everything reads it: the
 *   gate's dispatch decisions ({@link pendingReplaySpeed}), a jump's capture of
 *   the speed before its press and every surface ({@link resolveLiveSpeed}). It
 *   ends on the first sample that shows it — a tick, or any read handed in —
 *   or when {@link REPLAY_SPEED_HOLD_MS} passes without one. A pause is a sent
 *   speed too (0x).
 *
 *   **The chain.** Sends made while one is still pending form a chain, and
 *   the pending speed is shown only once telemetry has passed through the
 *   chain's sends in order up to the last one. Only a change in what
 *   telemetry reads counts — the same tick is read more than once (the
 *   engine's feed, then a surface or the gate), and the ticks still carrying
 *   the speed from before the chain must not count: playing at 1x, a 2x and
 *   then a 1x sent before telemetry shows the 2x leave a 1x pending that the
 *   old 1x ticks must not settle. Each change steps past the first send still
 *   ahead that it equals, so a send iRacing coalesced into a later one is
 *   skipped, and one that equals none of them moves nothing. So a chain that comes back to an
 *   earlier speed — the dial right, left, right inside the lag, or Play /
 *   Pause pressed twice or three times — is not settled by the first send
 *   landing.
 *
 *   **A cursor take supersedes it for the surfaces.** Whatever takes the
 *   replay cursor next (`replay-cursor.ts`: any replay command of any action
 *   takes it before it sends) may change the speed without sending one — a
 *   frame step pauses, a search clears slow motion — so from that take until
 *   the next send {@link resolveLiveSpeed} follows telemetry again; the dial's
 *   own take keeps it ({@link keepDialPendingSpeed}). The gate's own reads do
 *   not drop it: a press takes the cursor before the gate decides, and the
 *   decision must still see a speed sent the moment before (a frame step right
 *   after a Play goes into a replay that is starting to move). A change made
 *   from iRacing's own replay bar inside the lag, before telemetry has shown
 *   the send, cannot be told from a stale tick, so it is masked until the hold
 *   runs out; one made after telemetry has shown it is not, since the pending
 *   speed ended on that tick.
 * - The **remembered speed**: the last non-zero speed the replay played at,
 *   which the dial's Play/Pause resumes. It follows telemetry, so it is right
 *   whoever set the speed — a dial, a key or iRacing's own replay bar — and
 *   whether or not a Replay Control context is on screen. A 0 never
 *   overwrites it, and it is 1x before any sample. A non-zero send made with
 *   `rememberSpeed` — the dial's own, and every speed the gate's slot sends
 *   later — writes it at once, but only **provisionally**, because a broadcast
 *   reports no status: a send iRacing ignores (a speed sent while paused at
 *   the end of a saved recording) looks exactly like one it took. Telemetry
 *   passing through the chain of such sends to the last, by the same rule,
 *   confirms it.
 *   {@link REPLAY_SPEED_HOLD_MS} passing without one is the only sign the send
 *   was ignored, and the remembered speed then goes back to what it was before
 *   the first unconfirmed send. A send without `rememberSpeed` (a key's or a
 *   legacy action's, sent at once) moves only the pending speed.
 *
 * The provisional record outlives the pending speed on purpose. A pause sent
 * after an ignored speed, or another action taking the cursor, ends the
 * overlay but says nothing about whether that speed ever played.
 *
 * Every recorded send is told to the {@link onReplaySpeedChanged} listeners,
 * so a surface redraws even when a paused replay delivers no tick.
 *
 * Time is passed in, never read here. In memory only: a plugin restart starts
 * again at 1x, and nothing here belongs in persisted settings.
 */
import { onReplayCursorTaken } from "./replay-cursor.js";
import { engineLogger } from "./replay-engine-env.js";
import { isSameSpeed, NORMAL_SPEED, type ReplaySpeed } from "./replay-jump-speed.js";

/**
 * How long (ms) a send is given to show up in telemetry: the one hold of the
 * pending speed (#1427), for the gate, the jumps and the surfaces alike.
 * Telemetry showing the send ends it on that sample, so the hold only bounds
 * what telemetry never shows: a send iRacing ignored, a speed it changed
 * without being sent one, a send a later one overtook. It is the longer of
 * the two the engine had (the gate's and the jumps' 200 ms, the dial's
 * 500 ms) because a send the sim is slow to show must still count as sent:
 * the gate would otherwise record a frame step's target on a replay that is
 * starting to play, and the remembered speed would give back a speed that
 * took. For that long a speed iRacing ignored stays on a dial, and the
 * surface redraws when it lapses.
 */
export const REPLAY_SPEED_HOLD_MS = 500;

/**
 * The most sends a chain keeps (#1427). A chain lives only while each send
 * comes within {@link REPLAY_SPEED_HOLD_MS} of the one before, which is a
 * handful of sends; this bounds one that a dial spun without a pause keeps
 * alive. The oldest sends go first, with the cursor moved back by as many, so
 * the last send — the one a chain is shown by — is always kept; a sample of a
 * dropped send then counts for nothing, or for a later send of the same speed.
 */
const MAX_CHAIN_SENDS = 16;

/**
 * What telemetry has shown of a chain of unsettled sends: the guard of a
 * pending or provisional speed against ticks from before it (#1427).
 */
interface ChainWatch {
  /**
   * The last speed telemetry was seen to read: at first what it read when the
   * chain's first send went out, null when that was not known. A sample equal
   * to it is no change, and counts for nothing.
   */
  last: ReplaySpeed | null;
  /** The chain's sends in order, the last being the speed it stands for; at most {@link MAX_CHAIN_SENDS}. */
  readonly targets: readonly ReplaySpeed[];
  /** How many of {@link ChainWatch.targets} telemetry has passed through. */
  cursor: number;
}

/** A new chain of one send, `target`, begun while telemetry read `shown`. */
function startChain(target: ReplaySpeed, shown: ReplaySpeed | null): ChainWatch {
  return { last: shown === null ? null : { ...shown }, targets: [{ ...target }], cursor: 0 };
}

/** `chain` carried on by one more send, `target`, keeping at most {@link MAX_CHAIN_SENDS}. */
function continueChain(chain: ChainWatch, target: ReplaySpeed): ChainWatch {
  const targets = [...chain.targets, { ...target }];
  const dropped = Math.max(0, targets.length - MAX_CHAIN_SENDS);

  return {
    last: chain.last,
    targets: targets.slice(dropped),
    cursor: Math.max(0, chain.cursor - dropped),
  };
}

/** The speed just sent that telemetry does not show yet, and when it went out. */
interface PendingSpeed extends ChainWatch {
  readonly speed: ReplaySpeed;
  /** The send's timestamp (ms). */
  readonly sentAt: number;
}

/** A remembered speed a send wrote that telemetry has not confirmed yet. */
interface ProvisionalSpeed extends ChainWatch {
  /** The non-zero speed the latest unconfirmed send wrote into the remembered speed. */
  readonly speed: ReplaySpeed;
  /**
   * What the remembered speed was before the first unconfirmed send of the
   * chain, kept through every further one, so two ignored sends in a row still
   * go back to the speed the replay really played at.
   */
  readonly replaced: ReplaySpeed;
  /** The latest unconfirmed send's timestamp (ms). */
  readonly sentAt: number;
}

let pending: PendingSpeed | null = null;
/** Whether a cursor take since the last send has superseded the pending speed for the surfaces. */
let superseded = false;
let provisional: ProvisionalSpeed | null = null;
/** What the replay resumes at before it has been seen playing: 1x. */
let remembered: ReplaySpeed = { ...NORMAL_SPEED };

/** How many sends have been recorded: what {@link keepDialPendingSpeed} compares across its take. */
let sendCount = 0;

/** Who is told of every recorded send (module wiring; only the test reset clears it). */
const changeListeners = new Set<(speed: ReplaySpeed) => void>();

/**
 * Notes `sample` on the chain `watch` keeps and says whether telemetry has
 * now shown the whole chain. A sample equal to the last one seen is no
 * change and counts for nothing: the same tick read again, or a tick still
 * carrying the speed from before the chain (with that not known, the first
 * sample is a change). A change steps the cursor past the first send at or
 * after it that it equals — so a send iRacing coalesced into a later one is
 * skipped — and one equal to none of them moves nothing. The chain is shown
 * once the cursor has passed its last send.
 */
function shows(watch: ChainWatch, sample: ReplaySpeed | null): boolean {
  if (sample === null || (watch.last !== null && isSameSpeed(sample, watch.last))) return false;

  watch.last = { ...sample };

  for (let i = watch.cursor; i < watch.targets.length; i++) {
    if (isSameSpeed(sample, watch.targets[i])) {
      watch.cursor = i + 1;
      break;
    }
  }

  return watch.cursor >= watch.targets.length;
}

/**
 * The pending speed that still stands, or null. A sample showing it, or the
 * hold running out, drops it here for good, so a replay that later passes
 * through the same speed does not revive it.
 */
function settlePending(sample: ReplaySpeed | null, nowMs: number): PendingSpeed | null {
  if (pending === null) return null;

  if (shows(pending, sample) || nowMs - pending.sentAt >= REPLAY_SPEED_HOLD_MS) {
    pending = null;
    superseded = false;
  }

  return pending;
}

/**
 * Resolves the provisional remembered speed against one telemetry sample (or
 * none) and the clock, and returns the record if it still stands. A sample
 * showing its speed confirms it: the send took and the remembered speed
 * stays. The hold passing without one means iRacing did not act on the send,
 * and the remembered speed goes back to what the chain replaced — but only
 * while it is still the speed that send wrote: a Reverse made while paused
 * has since replaced it with the user's own choice.
 */
function settleProvisional(sample: ReplaySpeed | null, nowMs: number): ProvisionalSpeed | null {
  if (provisional === null) return null;

  if (shows(provisional, sample)) {
    provisional = null;
  } else if (nowMs - provisional.sentAt >= REPLAY_SPEED_HOLD_MS) {
    if (isSameSpeed(remembered, provisional.speed)) remembered = { ...provisional.replaced };

    provisional = null;
  }

  return provisional;
}

/**
 * The replay speed now, as every surface shows it and a jump captures it:
 * `telemetrySpeed` (the latest reading's, null when it carries none),
 * overlaid by a speed the gate sent that telemetry does not show yet, unless
 * a cursor take has superseded it since. No telemetry speed and nothing
 * pending reads as paused. The reading also resolves a provisional remembered
 * speed, so a caller that needs both the live and the remembered speed reads
 * this one first.
 */
export function resolveLiveSpeed(telemetrySpeed: ReplaySpeed | null, nowMs: number): ReplaySpeed {
  settleProvisional(telemetrySpeed, nowMs);

  const held = settlePending(telemetrySpeed, nowMs);

  if (held !== null && !superseded) return { ...held.speed };

  return telemetrySpeed === null ? { speed: 0, slowMotion: false } : { ...telemetrySpeed };
}

/**
 * The pending speed as the replay command gate reads it for its dispatch
 * decisions: a speed just sent that `telemetrySpeed` does not show yet, or
 * null. A cursor take since the send does not drop it here: the press that
 * took the cursor is the one being decided, and it goes into a replay that
 * was just sent that speed.
 */
export function pendingReplaySpeed(telemetrySpeed: ReplaySpeed | null, nowMs: number): ReplaySpeed | null {
  const held = settlePending(telemetrySpeed, nowMs);

  return held === null ? null : { ...held.speed };
}

/** How a send is recorded. */
export interface ReplaySpeedSendOptions {
  /** Whether a non-zero send is also the speed the dial's Play/Pause resumes. */
  readonly rememberSpeed: boolean;
  /**
   * The speed telemetry read when the send went out, null when it carried
   * none: the first "last seen" of a chain of sends starting here, so the
   * ticks still carrying it are no change. Left out, it is not known, and the
   * first sample counts as a change.
   */
  readonly telemetrySpeed?: ReplaySpeed | null;
}

/**
 * Records a speed the replay command gate just sent, a pause (0x) included,
 * without telling the listeners: the gate records a send the moment it goes
 * out, so its next decision reads it, and tells the listeners once its change
 * is complete ({@link announceReplaySpeedSent}). The target becomes the
 * pending speed. A send while an earlier one is still pending continues its
 * chain: it keeps what telemetry read when the chain began and the sends
 * telemetry has still to pass through, and adds this one. With
 * `rememberSpeed` a non-zero one is also written to the remembered speed at
 * once, provisionally: the dial's next Play/Pause resumes it even before
 * telemetry has shown it, and it stays only if telemetry does. A 0x send, or
 * one without `rememberSpeed`, leaves the remembered speed, and any
 * provisional record, alone.
 */
export function recordReplaySpeedSent(target: ReplaySpeed, nowMs: number, options: ReplaySpeedSendOptions): void {
  const shown = options.telemetrySpeed ?? null;
  // The reading of the send's own moment settles what it shows, and lapses what has run out, before a chain goes on.
  const chain = settlePending(shown, nowMs);

  pending = {
    speed: { ...target },
    sentAt: nowMs,
    ...(chain !== null ? continueChain(chain, target) : startChain(target, shown)),
  };
  superseded = false;
  sendCount++;

  if (options.rememberSpeed && target.speed !== 0) {
    // A record whose hold ran out with nothing reading it since lapses first, so
    // a new chain starts from the remembered speed that lapse restores.
    const standing = settleProvisional(shown, nowMs);

    provisional = {
      speed: { ...target },
      replaced: standing?.replaced ?? { ...remembered },
      sentAt: nowMs,
      ...(standing !== null ? continueChain(standing, target) : startChain(target, shown)),
    };
    remembered = { ...target };
  }
}

/**
 * Tells every {@link onReplaySpeedChanged} listener of a send already
 * recorded with {@link recordReplaySpeedSent}: the gate's, once its change
 * is complete, so a listener that reads the gate reads it whole.
 */
export function announceReplaySpeedSent(target: ReplaySpeed): void {
  for (const listener of [...changeListeners]) {
    try {
      listener({ ...target });
    } catch (err) {
      engineLogger("ReplaySpeed").debug(`Replay speed listener failed: ${String(err)}`);
    }
  }
}

/**
 * Runs `listener` on every send recorded, with the speed sent: a key's or a
 * dial's press, a speed the gate's slot sends later, a search's pause and
 * closing speed, a jump's or a walk's pause. A paused replay may deliver no
 * tick, so this is what redraws the surfaces; a redraw that changes nothing is
 * theirs to skip. Returns the unsubscribe.
 */
export function onReplaySpeedChanged(listener: (speed: ReplaySpeed) => void): () => void {
  changeListeners.add(listener);

  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * Supersedes the pending speed for the surfaces: something just took the
 * replay cursor to send a command of its own, which may change the speed
 * without sending one (a frame step pauses, a search clears slow motion), so
 * {@link resolveLiveSpeed} follows telemetry again at once, until the gate
 * records that command's own send. Without it a key's command inside the
 * hold would be masked: the box would still read the dial's last speed, and
 * Frame Jog would step a replay it believes paused. The gate's reads
 * ({@link pendingReplaySpeed}) still see the speed, as does nothing else: the
 * hold, the chain and the remembered speed with its provisional record are
 * left alone. Runs on every cursor take (registered below); a dial's own take
 * goes through {@link keepDialPendingSpeed}.
 */
export function supersedePendingSpeed(): void {
  if (pending !== null) superseded = true;
}

/**
 * Runs `take` — a dial taking the replay cursor for its own command — and
 * keeps the pending speed standing for the surfaces as it was before, unless
 * a send was recorded inside `take`. A dial's command does not supersede the
 * dial's last send the way another action's does: Frame Jog pauses and then
 * steps, and the step must still read the replay as paused. A speed the dial
 * sends replaces it: the gate records that send inside `take`, and it stands.
 */
export function keepDialPendingSpeed<T>(take: () => T): T {
  const wasSuperseded = superseded;
  const sendsBefore = sendCount;

  try {
    return take();
  } finally {
    if (sendCount === sendsBefore && pending !== null) superseded = wasSuperseded;
  }
}

// Every replay command of every action takes the cursor before it sends.
onReplayCursorTaken(supersedePendingSpeed);

/**
 * Feeds one telemetry sample to the pending and the remembered speed. Called
 * by the engine's tick feed (`replay-speed-feed.ts`) on every tick that is in
 * a replay, and on no other: out of a replay `ReplayPlaySpeed` says nothing
 * about what a replay last played at. A sample showing the pending speed ends
 * it. For the remembered speed a 0 changes nothing. Neither does a sample
 * taken while a sent speed is still provisional: until telemetry shows that
 * send, a tick carries the speed from before it, which would overwrite the
 * newer one the send wrote. A pending pause holds nothing back: a non-zero
 * sample arriving behind it is a speed that did play.
 */
export function noteTelemetrySpeed(sample: ReplaySpeed, nowMs: number): void {
  settlePending(sample, nowMs);

  if (settleProvisional(sample, nowMs) !== null) return;

  if (sample.speed !== 0) remembered = { ...sample };
}

/**
 * The speed Play/Pause resumes at: the last non-zero speed the replay played
 * at, 1x before any. A provisional one that has run out is noticed where a
 * sample or the live speed is read ({@link resolveLiveSpeed}), so a caller
 * that needs both reads that first.
 */
export function rememberedSpeed(): ReplaySpeed {
  return { ...remembered };
}

/**
 * Flips the remembered speed's direction, keeping its magnitude and
 * slow-motion flag — Reverse while paused, so the next Play/Pause resumes the
 * other way. Returns the flipped speed.
 */
export function reverseRememberedSpeed(): ReplaySpeed {
  remembered = { speed: -remembered.speed, slowMotion: remembered.slowMotion };

  return { ...remembered };
}

/** @internal Reset for tests: the speeds, and the change listeners. */
export function _resetReplaySpeedState(): void {
  pending = null;
  superseded = false;
  provisional = null;
  remembered = { ...NORMAL_SPEED };
  sendCount = 0;
  changeListeners.clear();
}
