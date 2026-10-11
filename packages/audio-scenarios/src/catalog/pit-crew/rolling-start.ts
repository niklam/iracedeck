/**
 * The rolling-start formation, narrated (issues #660 and #1167; scripted
 * since #1065) — three contracts over the translator's formation events:
 * the pace car pulling away, the last of two pace laps, and a change to the
 * car you form up behind.
 *
 * As everywhere since #1064, the code here decides WHETHER and WHEN the
 * engineer speaks and how the fire is scheduled; WHAT he says lives in the
 * active voice's `callouts.json` under the same ids, paired at `setScripts`
 * time. The bundled voice names the car to form up behind and, on an oval
 * running double file, the lane — read from the pace lineup at SPEAK time
 * through the `rollingStart.*` vocabulary, which `registerCautionVocabulary`
 * registers beside the `caution.*` names off the same resolver, so the two
 * families can never answer differently about one tick.
 *
 * **One of the three keeps another family's id.** The last-pace-lap call is
 * `pit-crew.flag-one-pace-lap-to-go` and keeps `family: "flag"` for
 * preemption, as it has since #480: a scenario id is published, every voice
 * pack scripts it by that name, and its opt-in is a stored setting. It is
 * built here because it is a formation call — it takes the formation gate
 * and records the car it names — and since #1167 its opt-in is listed with
 * the rolling-start family's (`ROLLING_START_CALLOUTS`).
 *
 * **All three are queueable and re-check the formation at SPEAK time.** The
 * field rolls out side by side, so the spotter is talking exactly when these
 * fire, and a call dropped for a busy bus is the instruction the driver
 * needed. A queued fire replays WITHOUT its `where:` being re-evaluated and
 * may wait for the bus, so each carries a `speakGate` asking the translator
 * whether the formation is still running: a formation call must never drain
 * into the launch, and once the green is held the green-held line owns the
 * moment. The gate asks the translator's formation state rather than live
 * telemetry, so a tick that cannot read telemetry silences nothing — a state
 * reader holds its last value and never answers "unknown". And because each
 * call is still true for as long as its gate admits it, each may wait as long
 * as a caution call does ({@link ROLLING_START_MAX_QUEUE_WAIT_MS}).
 *
 * **Only the change call also requires a pace row.** "The car ahead of you
 * has changed" is not true of a driver the lineup no longer holds, so its
 * gate reads the lineup live after the hold. The other two deliberately do
 * not: each has a numberless wording that must still speak — a road-course
 * rolling start may carry no pace rows at all, and "Pace car's rolling" and
 * "One lap to green" are true there too. This is the caution family's split,
 * for the caution family's reason (`caution.ts`, the towed player).
 *
 * **The change is judged against the car last NAMED in this formation**, the
 * caution's rule (issue #1286) through the same mechanism (`named-car.ts`).
 * The pace-car call and the one-lap-to-green call both name the car live, so
 * a change queued behind either would repeat the car just said; and a follow
 * car that flickers away and back inside the hold comes back to the car
 * already named. So the three calls record the lineup's follow car when their
 * gate admits them, tagged with the formation's id, and the change speaks
 * only when the car ahead differs from that record. Before anything is named
 * — the pace-car call switched off, dropped, or never due because the driver
 * was not in the car — it is judged against the formation's first follow car,
 * the baseline the translator's diff does not report as a change.
 *
 * **Weights.** The pace-car call sits at `WEIGHT.SAFETY`: pre-start
 * information the driver acts on, not a CRITICAL interrupt like "lights are
 * red". The change call sits one notch below it with NO `family`, exactly as
 * the caution's does. No family, because same-family preemption is wholesale
 * and a change arriving while "Pace car's rolling" plays would cut it
 * mid-word. One notch below, because the bus's queue plays the heavier first
 * and drops the lightest when it is full (issue #1185): a change always waits
 * behind a waiting formation call and is the one lost, never it — and losing
 * it costs nothing, since that call reads the lineup live and names the new
 * car anyway. `queueBehind` keeps the pair in order on a bus held by a focus
 * floor as well, so the change's gate is asked only once its sibling has
 * named its car.
 *
 * **Gating.** Every contract carries the flag family's `liveRaceCar`
 * predicate — a race session, live in the car, not past the checkered — so
 * the events stay publishable and harness-firable while only a driver in a
 * race hears them. A standing start has no formation: it never enters
 * `ParadeLaps`, carries no pace rows, and the start-light gantry and
 * countdown own it.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContract, SpeakGate } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import type { PaceLineupResolver } from "./caution.js";
import { CAUTION_MAX_QUEUE_WAIT_MS, flagContract, liveRaceCar } from "./flag-alerts.js";
import { createNamedCarMemory, type LastNamedCar, type NamingEpisode } from "./named-car.js";

/**
 * Reader the plugins wire to `getRollingStartFormation()` from
 * `@iracedeck/sim-events-iracing`: WHICH rolling-start formation is running —
 * an id that never repeats in the process, and the follow car read as the
 * formation began — or `null` while none is (issue #1167). The translator
 * holds the formation from the `ParadeLaps` entry edge until the session
 * leaves `ParadeLaps` or the green is held or shown.
 *
 * It answers two questions here. "Is the formation still running" is the
 * speak-time gate on all three contracts, and the id scopes the memory of the
 * car last named to one formation — which is why this is the formation's
 * identity rather than a boolean. Declared structurally, so the contract
 * layer names no translator type for it.
 */
export type RollingStartFormationResolver = () => NamingEpisode | null;

/**
 * What {@link buildRollingStartContracts} is built against: the formation,
 * for the speak-time gate and to scope the car last named; and the lineup,
 * read at SPEAK time by the change call's pace-row check and by the three
 * calls that record the car they name.
 */
export type RollingStartContractDeps = {
  getRollingStartFormation: RollingStartFormationResolver;
  getPaceLineup: PaceLineupResolver;
};

/**
 * How long a lineup change holds before deciding (issue #1167). It coalesces
 * a renumbering spread over several ticks into one decision — a fresh change
 * replaces the held one — on the car the field settled on: the rows behind a
 * car that leaves close up over a tick or two, and a car being passed moves
 * through several slots. Shorter than the caution's hold because nothing
 * here has been seen to flicker; the memory of the car last named is what
 * keeps a round trip silent, not the hold.
 */
export const ROLLING_START_LINEUP_CHANGE_DELAY_MS = 1500;

/**
 * How long a formation call may wait for the bus (issue #1185's rule): as
 * long as a caution call, and for the same reason. Each of the three is still
 * true for as long as its gate admits it — it re-checks at speak time that
 * the formation is running and names the car that is ahead then — and the
 * field rolling out side by side keeps the spotter on the bus for longer than
 * the engine's default.
 */
export const ROLLING_START_MAX_QUEUE_WAIT_MS = CAUTION_MAX_QUEUE_WAIT_MS;

/** The pace-car call's id — the rolling-start family's first, since #660. */
const PACE_CAR_SCENARIO_ID = "pit-crew.rolling-start-pace-car";

/** The fields the two contracts under the rolling-start prefix share. */
function rollingStartContract(subject: string): Omit<ScenarioContract, "description" | "when"> {
  return {
    id: `pit-crew.rolling-start-${subject}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.SAFETY,
    family: "rolling-start",
  };
}

/**
 * How the Telemetry Snapshot reaches the one piece of state this family
 * keeps (issue #1387). The car last named lives in a build's own memory
 * (`named-car.ts`), where nothing outside the build can read it, so each
 * build leaves a reader of its own here and the newest wins — the plugin
 * builds once, in `registerPitCrew`. `null` until the first build.
 */
let readNewestLastNamed: (() => LastNamedCar | null) | null = null;

/**
 * This file's state, for the Telemetry Snapshot (issue #1387): the car the
 * newest build last named and the formation it named it in — what a lineup
 * change during the formation is judged against. A pure read; `null` before
 * any build.
 */
export function readRollingStartDebugState(): { lastNamed: LastNamedCar | null } {
  return { lastNamed: readNewestLastNamed?.() ?? null };
}

/**
 * The family, built against the plugin's formation readers — the shape of
 * `buildCautionContracts`. A builder rather than a constant because every
 * contract asks the formation reader at speak time, the change call asks the
 * lineup there too, and one build holds the car last named, shared by the
 * three calls that record it and the change call that reads it.
 */
export function buildRollingStartContracts({
  getRollingStartFormation,
  getPaceLineup,
}: RollingStartContractDeps): readonly ScenarioContract[] {
  /** The formation speak gate, on all three contracts. */
  const formationRunning: SpeakGate = {
    description: "Re-checked at speak time: the rolling-start formation is still running.",
    admit: () => getRollingStartFormation() !== null,
  };

  /** The car the engineer last told the driver about in THIS formation — see the module header. */
  const named = createNamedCarMemory({ getEpisode: getRollingStartFormation, getPaceLineup });

  // The newest build is the one the snapshot reads (issue #1387).
  readNewestLastNamed = named.read;

  /** The shared gate, plus "a formation is actually running" for the change, which is decided after its hold. */
  const inFormation = (e: SimEventOf<SimEventName>): boolean => liveRaceCar(e) && getRollingStartFormation() !== null;

  return [
    {
      ...rollingStartContract("pace-car"),
      // Never dropped for the spotter as the field rolls out side by side.
      queueable: true,
      maxQueueWaitMs: ROLLING_START_MAX_QUEUE_WAIT_MS,
      // The formation gate and nothing more: NO pace-row check, because the
      // numberless wording must still speak where there is no lineup to read.
      // The bundled voice names the car ahead here, so the gate records it.
      speakGate: named.naming(formationRunning),
      description:
        "The pace car pulls away to lead the formation of a rolling-start race, with you live in the car; the pace rows say who you form up behind and, on an oval running double file, in which lane.",
      when: { event: "rollingStart.pace-car-moving.raised", where: liveRaceCar },
    },
    {
      // The flag family's id, preemption family and weight, kept — see the
      // module header. Only its scheduling is the formation's.
      ...flagContract("one-pace-lap-to-go"),
      queueable: true,
      maxQueueWaitMs: ROLLING_START_MAX_QUEUE_WAIT_MS,
      // As the pace-car call: the formation gate, no pace-row check (a plain
      // "One lap to green." is true with no lineup too), and the car it names
      // is recorded.
      speakGate: named.naming(formationRunning),
      description:
        "The pace car begins the last lap of a two-lap rolling-start formation while the green is not yet held, with you live in the car; a one-lap formation has no such moment and never hears it.",
      // The translator's `diff/pace-laps.ts` owns the rolling-only, ParadeLaps
      // and final-lap decision (issues #657, #773).
      when: { event: "flag.one-pace-lap-to-go.raised", where: liveRaceCar },
    },
    {
      ...rollingStartContract("lineup-changed"),
      // Outside the family and one notch below the two calls it shares the
      // formation with — see the module header. Do not "tidy" either back.
      family: undefined,
      weight: WEIGHT.SAFETY - 1,
      queueable: true,
      maxQueueWaitMs: ROLLING_START_MAX_QUEUE_WAIT_MS,
      // Wait BEHIND either sibling still waiting, whatever arrives first, so
      // the pair plays in order and this gate is asked after the car is named
      // (#1108, #1286).
      queueBehind: [PACE_CAR_SCENARIO_ID, flagContract("one-pace-lap-to-go").id],
      triggerDelay: ROLLING_START_LINEUP_CHANGE_DELAY_MS,
      speakGate: {
        description:
          "Re-checked at speak time: the formation is still running, you still hold a pace row, and the car ahead is not the one last named in this formation.",
        // The judgement last: it records the car this call names. Before
        // anything is named it is judged against the formation's first car.
        admit: (ctx) =>
          formationRunning.admit(ctx) &&
          getPaceLineup() !== null &&
          named.admitChange((formation) => formation.firstFollowCarIdx),
      },
      description:
        "The car you form up behind changes during a rolling-start formation — a car ahead drops out or is passed — and a second and a half later it is still not the car the engineer last named.",
      // Decided after the hold. Whether the change is news is the gate's
      // question, asked at speak time against what was actually said.
      when: { event: "rollingStart.lineup.changed", where: inFormation },
    },
  ];
}

/**
 * The family's scenario ids, in the order a formation runs through them.
 * Derived from the contracts themselves so the two can never drift; the
 * readers they are built with cannot change an id.
 */
export const ROLLING_START_SCENARIO_IDS: readonly string[] = buildRollingStartContracts({
  getRollingStartFormation: () => null,
  getPaceLineup: () => null,
}).map((c) => c.id);

/**
 * The clip sources the family's bundled entries draw from, as a literal
 * list, since nothing derives it: its own six `rolling-start` bases — the
 * numberless pace-car line and the five that name a lane, a car or the front
 * of the field — and the ten `caution` bases the one-lap-to-green and change
 * calls share with the caution family, so the start and the restart say the
 * same words for the same moment. The completeness tests read it: the bundled
 * voice must ship at least one clip for each, and the family's bundled
 * entries must reference exactly this set. A `(group, base)` a script
 * addresses is published — renaming a base is a rename in every pack's script
 * and every pack's clip folder.
 */
export const ROLLING_START_CLIP_SOURCES: readonly { group: "rolling-start" | "caution"; base: string }[] = [
  { group: "rolling-start", base: "pace-car-moving" },
  { group: "rolling-start", base: "pace-car-moving-inside" },
  { group: "rolling-start", base: "pace-car-moving-outside" },
  { group: "rolling-start", base: "pace-car-moving-behind" },
  { group: "rolling-start", base: "pace-car-moving-leader" },
  { group: "rolling-start", base: "pace-car-moving-front-row" },
  { group: "caution", base: "one-to-go" },
  { group: "caution", base: "one-to-go-inside" },
  { group: "caution", base: "one-to-go-outside" },
  { group: "caution", base: "one-to-go-plain" },
  { group: "caution", base: "one-to-go-leader" },
  { group: "caution", base: "lineup-changed-inside" },
  { group: "caution", base: "lineup-changed-outside" },
  { group: "caution", base: "lineup-changed-plain" },
  { group: "caution", base: "lineup-changed-leader" },
  { group: "caution", base: "lineup-changed-noname" },
];
