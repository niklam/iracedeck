/**
 * The one record of the replay speed (#1316, #1467). Designs:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`, and
 * Decision 4 of `docs/superpowers/specs/2026-10-20-issue-1467-replay-engine-package.md`.
 *
 * iRacing has one replay speed, so everything here is ONE module-wide value,
 * never per dial or per key. The replay command gate feeds it every speed it
 * actually sends ({@link noteReplaySpeedSent}), whichever surface asked, and
 * telemetry feeds it through {@link noteTelemetrySpeed}. Two things are kept,
 * and they are separate concerns:
 *
 * - The **pending speed**, an overlay on the live speed: what was just sent.
 *   `ReplayPlaySpeed` reports a new speed only on a later tick, so a second
 *   detent or key press arriving first would walk from the old speed and send
 *   the same stop again. After a send the live speed therefore reads as the
 *   sent target until telemetry reports it or {@link DIAL_SPEED_HOLD_MS}
 *   passes — the Replay Markers landing hold (#1230), applied to speed. A
 *   pause is a sent speed too (0x). Whatever takes the replay cursor next
 *   supersedes it at once — any replay command of any action, since each takes
 *   the cursor before it sends (`replay-cursor.ts`) — until the gate records
 *   that command's own send. A change made from iRacing's own replay bar
 *   inside the hold cannot be told from a stale tick, so it is masked until
 *   the hold runs out, which is when the hold heals itself.
 * - The **remembered speed**: the last non-zero speed the replay played at,
 *   which the dial's Play/Pause resumes. It follows telemetry, so it is right
 *   whoever set the speed — a dial, a key or iRacing's own replay bar. A 0
 *   never overwrites it, and it is 1x before any sample. A non-zero send made
 *   with `rememberSpeed` — the dial's own, and every speed the gate's slot
 *   sends later — writes it at once, but only **provisionally**, because a
 *   broadcast reports no status: a send iRacing ignores (a speed sent while
 *   paused at the end of a saved recording) looks exactly like one it took. A
 *   telemetry sample carrying the sent speed confirms it.
 *   {@link DIAL_SPEED_HOLD_MS} passing without one is the only sign the send
 *   was ignored, and the remembered speed then goes back to what it was before
 *   the first unconfirmed send. A send without `rememberSpeed` (a key's or a
 *   legacy action's, sent at once) moves only the pending speed.
 *
 * The provisional record outlives the overlay on purpose. A pause sent after
 * an ignored speed, or another action taking the cursor, ends the overlay but
 * says nothing about whether that speed ever played.
 *
 * Every recorded send is told to the {@link onReplaySpeedChanged} listeners,
 * so a surface redraws even when a paused replay delivers no tick.
 *
 * Time is passed in, never read here. In memory only: a plugin restart starts
 * again at 1x, and nothing here belongs in persisted settings.
 */
import { onReplayCursorTaken } from "./replay-cursor.js";
import { engineLogger } from "./replay-engine-env.js";
import { isSameSpeed, type ReplaySpeed } from "./replay-jump-speed.js";

/**
 * @internal Exported for testing
 *
 * How long (ms) a send is given to show up in telemetry: long enough for the
 * sim to answer a broadcast. For that long the sent speed stands in for the
 * live one, and a non-zero one sent with `rememberSpeed` is the remembered
 * speed provisionally. When it runs out unreported the send is taken as one
 * iRacing did not act on: the live speed is telemetry's again and the
 * remembered speed goes back to what it was. So it is also how long a speed
 * iRacing ignored stays on a dial; the surface redraws when it lapses.
 */
export const DIAL_SPEED_HOLD_MS = 500;

/** The live-speed overlay: a speed the gate sent, and when. */
interface PendingSpeed {
  readonly speed: ReplaySpeed;
  /** The send's timestamp (ms). */
  readonly sentAt: number;
}

/** A remembered speed a send wrote that telemetry has not confirmed yet. */
interface ProvisionalSpeed {
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

/** What the replay resumes at before it has been seen playing. */
const NORMAL_SPEED: ReplaySpeed = { speed: 1, slowMotion: false };

let pending: PendingSpeed | null = null;
let provisional: ProvisionalSpeed | null = null;
let remembered: ReplaySpeed = { ...NORMAL_SPEED };

/** How many sends have been recorded: what {@link keepDialPendingSpeed} compares across its take. */
let sendCount = 0;

/** Who is told of every recorded send (module wiring; only the test reset clears it). */
const changeListeners = new Set<(speed: ReplaySpeed) => void>();

/**
 * The pending speed that still stands for the live one, or null. Telemetry
 * reporting it, or the hold running out, drops it here for good, so a replay
 * that later passes through the same speed does not revive it.
 */
function settlePending(telemetrySpeed: ReplaySpeed | null, nowMs: number): PendingSpeed | null {
  if (pending === null) return null;

  const reported = telemetrySpeed !== null && isSameSpeed(telemetrySpeed, pending.speed);

  if (reported || nowMs - pending.sentAt >= DIAL_SPEED_HOLD_MS) pending = null;

  return pending;
}

/**
 * Resolves the provisional remembered speed against one telemetry sample (or
 * none) and the clock, and returns the record if it still stands. A sample
 * carrying its speed confirms it: the send took and the remembered speed
 * stays. The hold passing without one means iRacing did not act on the send,
 * and the remembered speed goes back to what the chain replaced — but only
 * while it is still the speed that send wrote: a Reverse made while paused
 * has since replaced it with the user's own choice.
 */
function settleProvisional(sample: ReplaySpeed | null, nowMs: number): ProvisionalSpeed | null {
  if (provisional === null) return null;

  if (sample !== null && isSameSpeed(sample, provisional.speed)) {
    provisional = null;
  } else if (nowMs - provisional.sentAt >= DIAL_SPEED_HOLD_MS) {
    if (isSameSpeed(remembered, provisional.speed)) remembered = { ...provisional.replaced };

    provisional = null;
  }

  return provisional;
}

/**
 * The replay speed now: `telemetrySpeed` (the latest reading's, null when it
 * carries none), overlaid by a speed the gate sent that telemetry has not
 * caught up with. No telemetry speed and nothing pending reads as paused. The
 * reading also resolves a provisional remembered speed, so a caller that needs
 * both the live and the remembered speed reads this one first.
 */
export function resolveLiveSpeed(telemetrySpeed: ReplaySpeed | null, nowMs: number): ReplaySpeed {
  settleProvisional(telemetrySpeed, nowMs);

  const held = settlePending(telemetrySpeed, nowMs);

  if (held !== null) return { ...held.speed };

  return telemetrySpeed === null ? { speed: 0, slowMotion: false } : { ...telemetrySpeed };
}

/**
 * Records a speed the replay command gate just sent, a pause (0x) included;
 * the gate calls it only when the command actually went out. The target
 * becomes the live speed for the hold. With `rememberSpeed` a non-zero one is
 * also written to the remembered speed at once, provisionally: the dial's next
 * Play/Pause resumes it even before telemetry has reported it, and it stays
 * only if telemetry does. A 0x send, or one without `rememberSpeed`, leaves
 * the remembered speed, and any provisional record, alone. Then every
 * {@link onReplaySpeedChanged} listener is told.
 */
export function noteReplaySpeedSent(
  target: ReplaySpeed,
  nowMs: number,
  options: { readonly rememberSpeed: boolean },
): void {
  pending = { speed: { ...target }, sentAt: nowMs };
  sendCount++;

  if (options.rememberSpeed && target.speed !== 0) {
    // A record whose hold ran out with nothing reading it since lapses first, so
    // a new chain starts from the remembered speed that lapse restores.
    const standing = settleProvisional(null, nowMs);

    provisional = { speed: { ...target }, replaced: standing?.replaced ?? { ...remembered }, sentAt: nowMs };
    remembered = { ...target };
  }

  for (const listener of [...changeListeners]) {
    try {
      listener({ ...target });
    } catch (err) {
      engineLogger("ReplaySpeed").debug(`Replay speed listener failed: ${String(err)}`);
    }
  }
}

/**
 * Runs `listener` on every send {@link noteReplaySpeedSent} records, with the
 * speed sent: a key's or a dial's press, a speed the gate's slot sends later,
 * a search's pause and closing speed, a jump's or a walk's pause. A paused
 * replay may deliver no tick, so this is what redraws the surfaces; a redraw
 * that changes nothing is theirs to skip. Returns the unsubscribe.
 */
export function onReplaySpeedChanged(listener: (speed: ReplaySpeed) => void): () => void {
  changeListeners.add(listener);

  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * Drops the pending speed: something else just took the replay cursor to send
 * a command of its own, so the last send no longer says what the replay is
 * doing and the live speed follows telemetry again at once, until the gate
 * records that command's own send. Without it a key's Play inside the hold
 * would be masked: the box would still read the dial's speed, and Frame Jog
 * would step a replay it believes paused. The remembered speed and its
 * provisional record are left alone: whether the sent speed ever played is
 * still telemetry's to say. Runs on every cursor take (registered below); a
 * dial's own take goes through {@link keepDialPendingSpeed}.
 */
export function clearDialPendingSpeed(): void {
  pending = null;
}

/**
 * Runs `take` — a dial taking the replay cursor for its own command — and
 * puts back the pending speed that stood before it, unless a send was
 * recorded inside `take`. A dial's command does not supersede the dial's last
 * send the way another action's does: Frame Jog pauses and then steps, and
 * the step must still read the replay as paused. A speed the dial sends
 * replaces it: the gate records that send inside `take`, and it stands.
 */
export function keepDialPendingSpeed<T>(take: () => T): T {
  const held = pending;
  const sendsBefore = sendCount;

  try {
    return take();
  } finally {
    if (sendCount === sendsBefore) pending = held;
  }
}

// Every replay command of every action takes the cursor before it sends.
onReplayCursorTaken(clearDialPendingSpeed);

/**
 * Feeds one telemetry sample to the remembered speed. Call it on every tick
 * that is in a replay, and on no other: out of a replay `ReplayPlaySpeed` says
 * nothing about what a replay last played at. A 0 changes nothing. Neither
 * does a sample taken while a sent speed is still provisional: until telemetry
 * reports that send, a tick carries the speed from before it, which would
 * overwrite the newer one the send wrote. A pending pause holds nothing back:
 * a non-zero sample arriving behind it is a speed that did play.
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
  provisional = null;
  remembered = { ...NORMAL_SPEED };
  sendCount = 0;
  changeListeners.clear();
}
