/**
 * Translator state struct — carries the "previous tick" data needed to
 * detect transitions. Held by the translator singleton and passed to each
 * diff module on every tick.
 *
 * Initial state uses sentinel values (negative / null / empty sets) so the
 * first tick after connect seeds without firing spurious transition events.
 */
import { type IncidentType, type PitBoxMark, type RadarState, TrackWetness } from "@iracedeck/event-bus";
import type { GapTrendDirection, ProgressTrace } from "@iracedeck/iracing-sdk";
import type { CornerMarker } from "@iracedeck/track-data";

/** Live gap snapshot for one class-standings neighbor (issue #933). */
export type GapNeighborState = {
  /** The neighbor's car index. */
  carIdx: number;
  /** Crossing-time gap in seconds; null while the traces can't cover the lookup. */
  gapSeconds: number | null;
  /** Whole laps the pair is apart (0 = same racing lap). */
  lapDelta: number;
  /** Continuous display trend (gap now vs one lap ago at this track position). */
  trend: GapTrendDirection | null;
};

export type MaterialSample = {
  t: number; // timestamp (ms since epoch)
  material: number; // TrkSurf-like enum value
};

/** Per-service debounce tracker for single-bit pit-service toggles. */
export type ServiceDebounceState = {
  pendingAt: number; // 0 = stable; >0 = ms timestamp of most recent flip
  lastSeen: boolean; // most recent observed bit value
};

export type TranslatorState = {
  // ── Pit lane / stall ────────────────────────────────────────────────────
  pitLaneInitialized: boolean;
  lastOnPitRoad: boolean;
  lastInPitStall: boolean;
  approachExitingSuppressed: boolean;
  approachAlertFired: boolean;
  /**
   * Re-entry cooldown deadline (ms timestamp) for the `pitLane.approaching`
   * callout (issue #650). The pit-lane diff suppresses the callout while
   * `now < pitApproachCooldownUntil` and re-arms the window
   * (`now + PIT_APPROACH_COOLDOWN_MS`) on each real fire, so an accidental
   * drive-out / drive-back-in within the window doesn't re-announce. Gates both
   * the dirt-oval drive-in edge and the road-course approach-zone entry. `0`
   * before the first fire (cooldown inactive).
   */
  pitApproachCooldownUntil: number;
  /**
   * Pit-box count-in marks already spoken (or seeded as already-passed) during
   * the current pit-road visit (issue #600). The diff fires each
   * {@link PitBoxMark} at most once per visit; the set is cleared whenever the
   * car is not on pit road, so a second stop counts down again. On the first
   * valid tick of a visit the thresholds the car is already past are seeded
   * here so only marks still AHEAD can fire — true threshold-crossing semantics,
   * so entering pit road mid-band never speaks a just-passed number.
   */
  pitBoxMarksSpoken: Set<PitBoxMark>;
  /**
   * Whether the one-time entry seeding has run for the current pit-road visit
   * (issue #600). Reset to false when the car leaves pit road; set true after
   * the first tick with a resolvable box position seeds already-passed marks
   * into {@link pitBoxMarksSpoken}. Gated on valid data (not merely on
   * `OnPitRoad`) so a visit that starts before the session YAML is parsed still
   * seeds correctly on the first tick the box becomes known.
   */
  pitBoxEntrySeeded: boolean;

  // ── Corner-name callouts (issue #888) ────────────────────────────────────
  /**
   * Previous tick's lead point (`LapDistPct` + speed-scaled lead offset,
   * folded into [0, 1)). `null` until the first valid practice tick seeds it
   * silently; reset to `null` whenever the diff's gates fail so a return to
   * the track starts a fresh pass.
   */
  cornerLeadPrevPct: number | null;
  /**
   * Marker indices (into the resolved marker array) already announced this
   * lap. Cleared when the lead point wraps past S/F, on teleport re-anchor,
   * and whenever the gates fail.
   */
  cornerSpoken: Set<number>;
  /**
   * Cache key (`${TrackID}|${SessionNum}`) for the resolved corner markers —
   * the same invalidation pattern as `trackLengthKey`.
   */
  cornerMarkersKey: string;
  /** Resolved corner markers for the current track, `null` when not in the dataset. */
  cornerMarkers: CornerMarker[] | null;

  /**
   * Whether the current lap began at pit exit. Set true by `diffPitLane`
   * when emitting `pitLane.exited`; cleared by `diffLifecycle` when
   * emitting `lap.started`. Used by the qualifying lap-invalidation
   * snapshot (issue #567) to suppress the callout on the session out-lap
   * and any mid-session post-pit-exit lap — neither is a timed attempt.
   */
  lapStartedFromPits: boolean;

  // ── Flags ───────────────────────────────────────────────────────────────
  flagStateInitialized: boolean;
  activeFlags: Set<string>;
  lastYellowScope: "local" | "full" | null;
  /**
   * Tracks whether ANY yellow-ish bit (`Yellow | YellowWaving | Caution |
   * CautionWaving`) was set last tick (issue #480). Drives the
   * `flag.yellow.cleared` emission so it fires exactly once when the field
   * goes fully green — and crucially does NOT mis-fire when a static yellow
   * escalates to its waving variant (which removes the `"yellow"` static key
   * from `activeFlags` but does not actually clear the caution).
   */
  lastAnyYellow: boolean;
  /**
   * Timestamp (ms) of the most recent all-yellow-bits drop edge, while a
   * `flag.yellow.cleared` emission is pending its sustain window (issue
   * #671). iRacing's yellow bits mirror the flag SHOWN to the player —
   * `YellowWaving` drops the moment the player passes out of the affected
   * zone and re-raises next lap — so the cleared edge is only announced once
   * the all-clear has held for `YELLOW_CLEARED_HOLD_MS`. Any yellow-ish
   * re-raise cancels the pending clear. `null` when no clear is pending.
   */
  yellowClearPendingSince: number | null;
  /**
   * Timestamp (ms) when the `Furled` bit's rising edge was observed, while a
   * `flag.furled.raised` emission is pending its debounce window (issue
   * #669). Running briefly off track flashes the bit for ~0.5 s without a
   * genuine furled-black-flag warning, so the raised callout only fires once
   * the bit has stayed set for `FURLED_DEBOUNCE_MS`; the bit clearing
   * meanwhile drops the pending announcement. `0` when no announce is
   * pending.
   */
  furledPendingAt: number;
  /**
   * True once `flag.furled.raised` has actually been emitted for the current
   * furled episode (issue #669). Gates the paired `flag.furled.cleared` on
   * the falling edge — a transient flicker that never announced fires
   * neither event.
   */
  furledAnnounced: boolean;
  /**
   * Previous-tick `LapCompleted`, for detecting the player's start/finish
   * crossings inside the flag diff (issue #771). `null` until a valid value
   * has been observed.
   */
  flagLastLapCompleted: number | null;
  /**
   * Timestamp (ms) of the player's most recent scored S/F crossing (a
   * `LapCompleted` increment) as seen by the flag diff (issue #771). `0`
   * when no crossing has been observed yet. Drives the winner grace window
   * (`FLAG_CROSS_GRACE_MS`): the leader's own finish CAUSES the checkered
   * bit to rise, possibly a tick or two after their crossing was scored.
   */
  flagLastCrossedAt: number;
  /**
   * True while a raised checkered is being held back until the player takes
   * the flag at the S/F line (issue #771). iRacing raises the `Checkered`
   * bit for the whole field the moment the session ends, which can be most
   * of a lap before the player reaches the line.
   */
  checkeredPendingCross: boolean;
  /**
   * True once `flag.white-last-lap.raised` has fired for the current white
   * episode (issue #772) — the player's S/F crossing under the white flag,
   * the start of THEIR last lap. Re-arms when the White bit drops.
   */
  whiteLastLapFired: boolean;
  /**
   * STICKY "the player started their final lap" latch (issue #880). Set
   * alongside {@link whiteLastLapFired} but — unlike it — NEVER re-armed
   * when the White bit drops: a caution replacing the white mid-final-lap
   * re-arms the two-stage callout latch, and this marker is what keeps the
   * fuel-callout family's final-lap suppression engaged through that flag
   * change (the only reliable final-lap signal in a timed race). Preserved
   * across `wipeStateForReplay`; cleared by the per-session reset and by a
   * GREEN rising edge (`diffFlags`) — a green past the latched lap means
   * the race was extended (oval overtime) or restarted same-session (admin
   * !restart never changes SessionNum), and the fuel family must re-open
   * (#880 review).
   */
  playerFinalLapStarted: boolean;
  /**
   * Timestamp (ms) the white-flag heads-up (`flag.white.raised`) was emitted
   * for the current white episode (issue #772); `0` when none was (fresh
   * state, or the leader skip replaced it with the last-lap line). Drives
   * the `WHITE_LAST_LAP_MIN_GAP_MS` guard so a close follower's crossing
   * can't preempt the still-playing heads-up. Reset when the bit drops.
   */
  whiteRaisedAt: number;

  // ── Rolling-start pace laps (issue #657) ────────────────────────────────
  /**
   * Whether the pace-lap diff has seeded its baseline on the first tick. Seeds
   * `lastTickInParadeLaps` without arming so connecting mid-parade never
   * synthesizes a "one pace lap to go" (same caveat as the gantry bits).
   */
  paceLapInitialized: boolean;
  /** Previous-tick `SessionState === ParadeLaps`, for entry-edge detection. */
  lastTickInParadeLaps: boolean;
  /**
   * Whether the diff is armed for the current rolling formation — set on a
   * genuine `*→ParadeLaps` entry transition, cleared on any non-ParadeLaps tick.
   * Only an armed diff accumulates distance and can fire.
   */
  paceLapArmed: boolean;
  /**
   * Forward lap-distance accrued since entering ParadeLaps (laps, can exceed 1).
   * The grid-release S/F crossing sits at ~0 accrued; the first-pace-lap
   * completion crossing sits at ~1 — the `>= 0.5` fire guard separates them.
   */
  paceLapAccrued: number;
  /** Previous-tick lap-distance of the tracked car, for the per-tick forward-distance delta. */
  paceLapLastDistPct: number;
  /**
   * `CarIdx` of the car whose S/F crossings the pace-lap diff is tracking
   * THIS tick (issue #773): the PACE CAR whenever its telemetry is usable,
   * `null` to track the player's own `LapDistPct` instead. The pace car
   * crosses S/F — committing the field to another pace lap — before the
   * player does, so the cue keys on its crossing whenever possible; a
   * telemetry blip or a pit-lane peel-off flips to the player (with a
   * baseline re-anchor) and flips back when the pace car's data returns.
   */
  paceLapSourceCarIdx: number | null;
  /**
   * The pace car's `CarIdx` as resolved from session YAML at the formation's
   * entry edge (issue #773), `null` when unresolvable. Kept separate from
   * `paceLapSourceCarIdx` so a mid-parade downgrade to the player can
   * re-acquire the pace car when its telemetry returns valid.
   */
  paceLapPaceCarIdx: number | null;
  /**
   * Once-per-formation latch for `flag.one-pace-lap-to-go.raised`. Set when the
   * cue fires; cleared (with the rest of the pace-lap state) on any
   * non-ParadeLaps tick, so the next session's formation re-arms cleanly.
   */
  onePaceLapToGoFired: boolean;

  // ── Rolling-start field-rolling detection (issue #660) ──────────────────
  /** Whether the rolling-start diff has seeded its baseline on the first tick (seeds without firing). */
  rollingStartInitialized: boolean;
  /** Previous tick's `SessionState === ParadeLaps`, for ParadeLaps entry-edge detection. */
  lastInParadeLaps: boolean;

  // ── Pit window open/closed (issue #655) ─────────────────────────────────
  /**
   * Whether the pit-window diff has seeded its baseline on the first tick.
   * Seeds `lastPitsOpen` without firing so connecting mid-session (when
   * `PitsOpen` is already at some value) never blurts a phantom open/closed.
   */
  pitsOpenInitialized: boolean;
  /** Previous-tick `PitsOpen`, for boolean transition detection. */
  lastPitsOpen: boolean;

  // ── Start lights (issue #480) ───────────────────────────────────────────
  /**
   * Whether the start-light diff has seeded its baselines on the first tick
   * (mirrors `flagStateInitialized`). Seeds `lastStartLightBits` without
   * firing so connecting mid-grid doesn't synthesize start-light callouts.
   */
  startLightInitialized: boolean;
  /**
   * Previous-tick value of the two edge-detected gantry bits (`StartReady |
   * StartGo`) masked out of `SessionFlags`. Drives the rising-edge gantry
   * emissions (issue #673 — the heads-up line fires on Ready; nothing is
   * emitted for `StartSet`).
   */
  lastStartLightBits: number;
  /**
   * Highest eligible countdown threshold for the current standing pre-start
   * window — seeded from `SessionTimeRemain` on the first in-window tick.
   * `null` when not in a window. Only thresholds `<= ceiling` are eligible to
   * fire, so a window that starts mid-countdown (e.g. AI-compressed to ~4 s)
   * never speaks a number it already missed.
   */
  startCountdownCeiling: number | null;
  /**
   * Countdown thresholds already fired (or marked fired) during the current
   * standing pre-start window. Cleared on window exit so a re-grid counts
   * down again.
   */
  startCountdownFired: Set<number>;
  /**
   * Whether the countdown diff has consumed its first IN-WINDOW tick as a
   * silent observation (issue #829 — the countdown runs pre-guard and owns
   * its own seed, mirroring every diff's seed-silently convention). The
   * window-entry `SessionTimeRemain` can be a scheduled value an AI session
   * collapses right after (capture 2056: 262 s → 1.02 s), so the ceiling
   * anchors from the second in-window observation on; out-of-window ticks
   * never consume it. Once per state lifetime — deliberately NOT reset on
   * window exit, so the #666 blip semantics stay unchanged. Preserved across
   * `wipeStateForReplay` with the rest of the countdown cluster.
   */
  startCountdownObserved: boolean;

  // ── Toggles (pit service, car control) ──────────────────────────────────
  toggleStateInitialized: boolean;
  lastPitSvFlags: number; // For tire & pit-service bits this is the BASELINE (last emitted), not "previous tick".
  lastPitSvCompound: number;
  lastLimiterActive: boolean;
  lastP2PActive: boolean;
  lastDrsActive: boolean;
  // Pit-service debounce — coalesce iRacing's multi-tick transitions and
  // the user's rapid intent oscillations (e.g. accidental tap-tap on a
  // button). Each service tracks its own last-seen value and the
  // timestamp of the most recent flip; an event emits only after the bit
  // has been stable for the debounce window.
  fuelDebounce: ServiceDebounceState;
  windshieldDebounce: ServiceDebounceState;
  fastRepairDebounce: ServiceDebounceState;
  // Tire debounce — same model but over a 4-bit set rather than a single bit.
  lastSeenTireFlags: number; // most recent observed tire bits (any tick)
  lastTireChangeAt: number; // 0 = stable; >0 = ms timestamp of most recent tire flag flip

  // ── Pit-service readback (issue #476) ──────────────────────────────────
  pitReadbackInitialized: boolean;
  pitReadbackPrevOnPitRoad: boolean;
  pitReadbackExitFireAt: number; // 0 = none scheduled; >0 = ms timestamp to emit at
  /**
   * Pit-action confirmation cooldown. While `now < pitActionCooldownUntil`,
   * per-toggle confirmation scenarios stay silent. Set on `pitLane.exited`
   * (matches the readback exit delay so pit-actions don't blurt over the
   * pending "to confirm" beat) and on pre-start transitions (so iRacing's
   * grid-load pit-flag seeding doesn't fire phantom callouts).
   */
  pitActionCooldownUntil: number;
  /**
   * Pre-start auto-readback. Set on the pre-start enter transition and
   * fires once `now >= pitReadbackPreStartFireAt`. The snapshot is
   * built fresh from current telemetry at fire time so any toggle the
   * user makes during the muted-pit-actions window is reflected in
   * the recap (otherwise the user could change fuel/tires on the grid
   * and still hear a stale plan from grid entry).
   */
  pitReadbackPreStartFireAt: number;
  /**
   * Tracks the iRacing pre-start state (`PaceMode === SingleFileStart |
   * DoubleFileStart` AND `SessionState === ParadeLaps | Warmup |
   * GetInCar`) for edge detection. Reference: `ir_isPreStart()` in the
   * iRacing pit-board project.
   */
  lastTickInPreStart: boolean;

  // ── Track wetness (issue #526) ──────────────────────────────────────────
  // Tracks `TelemetryData.TrackWetness` across ticks so the diff can emit one
  // `track.wetness.changed` per real state transition. Seeded silently on
  // first tick; transitions involving Unknown are suppressed by the diff.
  trackWetnessInitialized: boolean;
  lastTrackWetness: TrackWetness;

  // ── Pit-service status (issue #479) ─────────────────────────────────────
  // Tracks PlayerCarPitSvStatus across ticks so the diff can emit one event
  // per transition. Seeded silently on first tick / off-track / in pit stall
  // for the same reason `lastPitSvFlags` is — the user isn't responsible for
  // those state changes and the engineer should stay silent on connect /
  // garage returns. Closing transitions (* → None) are suppressed in the
  // diff itself, not via baseline juggling.
  pitStatusInitialized: boolean;
  lastPitSvStatus: number; // PitSvStatus enum value

  // ── Pit limiter warnings ────────────────────────────────────────────────
  limiterInitialized: boolean;
  lastOnPitRoadForLimiter: boolean;
  lastLimiterOnPitRoad: boolean;
  speedingWarnedAt: number;

  // ── Incidents / off-track ───────────────────────────────────────────────
  lastIncidentCount: number; // -1 = not seeded
  offTrackStartedAt: number; // 0 = on track
  offTrackWarnedThisExcursion: boolean;
  materialHistory: MaterialSample[];
  offTrackPending: boolean; // true between offTrack.started and offTrack.ended
  // Latch for the transient `PlayerIncidents` byte (issue #530). iRacing
  // sets the IncidentFlags byte for ~one 16 ms tick then clears it, BEFORE
  // PlayerCarMyIncidentCount visibly increments (~32 ms / 2 frames later).
  // The diff caches the most recent classified type and consumes it when
  // the count delta arrives. Stale entries are rejected via timestamp;
  // `pendingIncidentTypeAt` is 0 when no type is pending.
  pendingIncidentType: IncidentType | null;
  pendingIncidentTypeAt: number; // 0 = no pending; >0 = ms timestamp captured at
  // Burst-coalesce buffer (issue #530). A single physical incident in
  // iRacing (one crash) often arrives as a stream of count increments
  // over ~hundreds of ms — e.g. off-track (1x) → out-of-control (2x) →
  // collision-with-car (4x). Without coalescing, each step fires a
  // separate callout and the engineer talks over himself. We hold the
  // most recent classification + accumulated delta in a buffer and only
  // emit once `INCIDENT_BURST_QUIET_MS` has passed without a new
  // increment, or once `INCIDENT_BURST_MAX_MS` has passed since the
  // first increment in the burst (hard cap so a sustained roll can't
  // delay the announcement indefinitely). `incidentBurstFirstAt` is 0
  // when no burst is pending.
  incidentBurstType: IncidentType | null;
  incidentBurstDelta: number;
  incidentBurstFirstAt: number; // 0 = no pending burst; >0 = ms timestamp of first increment
  incidentBurstLatestAt: number; // ms timestamp of most recent increment in this burst

  // ── Damage (issue #489) ─────────────────────────────────────────────────
  // Rising-edge detection for `EngineWarnings & (MandRepNeeded | OptRepNeeded)`
  // with a debounce window. The baseline is the last *emitted* state — once
  // damage has been announced, we hold that baseline until the bits clear so
  // sustained damage doesn't re-fire. Clear → damage cycles re-fire because
  // the baseline drops back to false on the falling edge (no event emitted).
  damageInitialized: boolean;
  damageBaseline: boolean; // true = damage announced and held
  damagePendingAt: number; // 0 = stable; >0 = ms timestamp of most recent flip
  damagePendingValue: boolean; // value the pending flip is moving toward

  // ── Overtakes ───────────────────────────────────────────────────────────
  overtakeInitialized: boolean;
  lastPosition: number;
  pendingOvertakePos: number;
  pendingOvertakeTime: number;
  lastConfirmedOvertakeCarIdx: number;
  /**
   * Whether the pending gain currently being held was caused (at least in
   * part) by a non-finished car ahead leaving the world — a retirement / DNF /
   * disconnect (issue #603). Captured when the gain pending opens and LATCHED
   * to `true` on any held tick where the retirement condition holds, so a
   * blended retire-plus-pass within one hold window is flagged conservatively.
   * Emitted as `overtake.completed.fromRetirement`; the audio layer then plays
   * the position readout but suppresses the "Nice pass" reaction. Reset to
   * `false` whenever the pending gain resets. Single-class detection only.
   * `false` when no pending gain is open.
   */
  pendingOvertakeFromRetirement: boolean;
  /**
   * Last position actually announced via an overtake gain/loss callout
   * (issue #597). A confirmed gain/loss is suppressed when the current
   * position equals this value — i.e. a round-trip back to the called
   * position (e.g. P10 → P9 → P10) where the intermediate position never
   * sustained long enough to be announced. Updated only when a callout is
   * emitted; seeded on the first eligible tick and rolled silently under
   * caution; compared in the same effective space the detection uses
   * (class position in multi-class per #588, overall otherwise). `-1`
   * before seeding.
   */
  lastCalledPosition: number;
  /**
   * Pre-gain baseline captured at the moment a pending gain is opened
   * (issue #574). Persists across ticks where the pending state is
   * being held / deepened, so the eventual `overtake.completed` payload's
   * `previousPosition` reflects the position right before the pass
   * started — not whatever `lastPosition` happens to be when the hold
   * window settles. `0` when no pending gain is open.
   */
  pendingOvertakePrevPos: number;
  pendingOvertakePrevClassPos: number;
  /**
   * Last observed class position (1-indexed; 0 = unknown). Tracked
   * across ticks so a position gain/loss can resolve `previousClassPosition`
   * without re-reading session info. Sourced from
   * `telemetry.PlayerCarClassPosition`.
   */
  lastClassPosition: number;
  /**
   * Pending position-loss tracker (issue #574). Mirrors `pendingOvertakePos`
   * but for the loss direction. `-1` when stable; otherwise stores the worst
   * (highest-number) position observed since the loss began. Emitted as
   * `overtake.lost` once the hold and physical-gap gates both pass.
   */
  pendingLossPos: number;
  pendingLossTime: number;
  pendingLossPrevPos: number;
  pendingLossPrevClassPos: number;
  /**
   * Track length in meters, parsed once per track/session from
   * `SessionInfo.WeekendInfo.TrackLength` (issue #574). Used to convert
   * `CarIdxLapDistPct` deltas into a physical gap so the overtake gates can
   * reject "3-second-clean but still side-by-side" passes. `null` until
   * parsed; consumers omit the gap from the event payload when null.
   */
  trackLengthMeters: number | null;
  /** Cache key (`${TrackID}|${SessionNum}`) for invalidating `trackLengthMeters`. */
  trackLengthKey: string;

  // ── Gaps (issue #933) ───────────────────────────────────────────────────
  /**
   * Per-car crossing-time traces: rolling ~1.15-lap history of
   * `lapCompleted + lapDistPct` progress against `SessionTime`, sparse-indexed
   * by carIdx. Owned here; all math on them lives in
   * `@iracedeck/iracing-sdk` `gap-utils.ts`.
   */
  gapTraces: (ProgressTrace | undefined)[];
  /** Cached class-neighbor car indices from the last tick (−1 = none). */
  gapAheadIdx: number;
  gapBehindIdx: number;
  /** Live gap snapshots `getLiveGaps()` reads; null = not computable this tick. */
  gapLiveAhead: GapNeighborState | null;
  gapLiveBehind: GapNeighborState | null;
  /**
   * Display-trend rate chain (issue #933 follow-up): the gap is sampled at
   * every 2% of player progress; adjacent-sample deltas (a couple of seconds
   * apart, where track-position noise is negligible) feed an exponential
   * moving average of the gap rate in seconds-per-lap. The key color
   * classifies that smoothed rate, so it goes live ~0.1 lap after any reset
   * instead of needing a full same-spot lap of history. Reset on neighbor
   * identity change and across any sampling break (pit visits, data gaps).
   */
  gapLastCheckpointAhead: { progress: number; gapSeconds: number } | null;
  gapLastCheckpointBehind: { progress: number; gapSeconds: number } | null;
  /** Smoothed gap rate (s/lap; negative = closing). Null until seeded. */
  gapRateEmaAhead: number | null;
  gapRateEmaBehind: number | null;
  /** Consecutive rate samples in the current chain (gates classification). */
  gapRateSamplesAhead: number;
  gapRateSamplesBehind: number;
  /** Player progress at the last recorded checkpoint (−1 before seeding). */
  gapLastCheckpointProgress: number;
  /** Lap-over-lap callout samples: the gap at the player's previous lap completion. */
  gapLapSampleAhead: number | null;
  gapLapSampleBehind: number | null;
  /** Direction of the previous lap's delta (per side), for the 2-lap confirmation. */
  gapPrevLapDirectionAhead: GapTrendDirection | null;
  gapPrevLapDirectionBehind: GapTrendDirection | null;
  /** Last direction announced via gap.trendChanged (per side). */
  gapAnnouncedDirectionAhead: GapTrendDirection | null;
  gapAnnouncedDirectionBehind: GapTrendDirection | null;
  /**
   * Threshold episode armed flags — arm only after the gap has been observed
   * beyond threshold + hysteresis, so a nose-to-tail race start can't fire a
   * crossing on the first green-flag tick.
   */
  gapThresholdArmedAhead: boolean;
  gapThresholdArmedBehind: boolean;
  /** Player `LapCompleted` at the last lap-sample capture (−1 before seeding). */
  gapLastLapCompleted: number;

  // ── Self-managed running order (issue #603) ─────────────────────────────
  /**
   * Per-car last-known good score (`CarIdxLapCompleted + CarIdxLapDistPct`) from
   * continuous on-track motion. iRacing zeroes the live `lc`/`dp` to `-1` the
   * instant a car is `NotInWorld` (proven by dump-file inspection of the car8
   * 1-tick blink), so we remember the last good value ourselves — that's the
   * "manage state ourselves" model.
   *
   * `calculateFrozenRacePositions` ranks each car by `positionLastKnownScores[i]`
   * while it's in {@link positionFrozen}; otherwise by the live `lc + dp`. The
   * player only overtakes a frozen car when their own score genuinely exceeds
   * the frozen point ("…until we've passed that point"). Updated each tick that
   * the car is moving normally on track; preserved across blinks / teleports.
   * `-1` (or absent index) means we haven't seen the car at all yet.
   */
  positionLastKnownScores: number[];
  /**
   * Cars currently FROZEN — either `NotInWorld` or showing a discontinuity from
   * their last-known on-track score (teleport / tow / drifted-away post-blink).
   * Members keep being ranked at their {@link positionLastKnownScores} entry
   * until they resume continuous on-track motion close to that anchor. Reset
   * via `createInitialState`; otherwise the set self-cleans tick-by-tick. Issue
   * #603.
   */
  positionFrozen: Set<number>;
  /**
   * Previous-tick FROZEN race positions (`calculateFrozenRacePositions` output,
   * with anchors applied), indexed by carIdx. Drives the overtake retirement
   * classifier: a gain is `fromRetirement` when some car that was ranked ahead
   * of the player in this snapshot is currently in {@link positionFrozen}.
   *
   * Using the frozen positions — not the raw `calculateRacePositions` — is what
   * lets the classifier fire on the tick the player CROSSES a frozen car's
   * anchor (which is when the rank actually changes in the production frozen
   * path), not just on the tick the car vanished (which is when the raw rank
   * shifts but the frozen rank is held by the anchor). Without this a finished
   * car vanishing into the garage would, several ticks later, produce a phantom
   * "Nice pass" because by then the raw `lastActivePositions` no longer
   * remembers the frozen car was ever ahead. `[]` until the first tick.
   * Issue #603.
   */
  lastFrozenPositions: number[];
  /**
   * Per-car score (`lc + dp`) from the previous in-world tick (issue #697).
   * `updatePositionTracking` compares it against the current score to tell
   * continuous racing motion (a small forward advance) apart from a teleport (a
   * discontinuous jump) and from a stop (no advance) — which is what decides
   * freezing a car on a tow and releasing it once it's moving again. Indexed by
   * carIdx; `undefined` for a car not yet seen in-world this connection.
   */
  positionPrevScore: number[];
  /**
   * Cars released from {@link positionFrozen} on THIS tick (issue #697). A
   * one-tick signal: `updatePositionTracking` clears it at the start of every
   * pass and adds a car when it resumes motion after a tow/teleport. The
   * overtake retirement classifier treats a just-released car the same as a
   * still-frozen one, so the player "gaining" a place because a towed rival
   * dropped back on release is classified `fromRetirement` (no "Nice pass")
   * rather than a real on-track pass. Read by `diffOvertakes` later in the same
   * tick, so the clear-then-populate order matters.
   */
  positionJustReleased: Set<number>;

  // ── Radar ─────────────────────────────────────────────────────────────
  radarState: RadarState;

  // ── Laps-of-fuel-left callouts (issue #838) ───────────────────────────────
  // NOTE: the validated fuel lap history (issue #465) deliberately does NOT
  // live here — it's the instance-level `FuelLapTracker` (see `fuel-laps.ts`)
  // so replay/garage state wipes and session changes don't destroy it.
  /**
   * Previous-tick `LapDistPct`, for the rising 0.5-crossing sample trigger.
   * `null` until the first valid tick (seed silently). Re-seeds after a
   * replay/garage gap — the jump made the edge comparison meaningless.
   */
  fuelCalloutLastDistPct: number | null;
  /**
   * `Lap` value of the last mid-lap sample, so a car rolling backwards and
   * forwards across the 0.5 mark can't sample the same lap twice. `-1` = none.
   */
  fuelCalloutLastSampledLap: number;
  /**
   * Previous-tick `FuelLevel` for refuel detection (a debounced per-tick
   * increase re-arms the announced counts). Preserved across
   * `wipeStateForReplay` so a garage refuel — which happens entirely inside
   * replay-mode ticks — lands as one big positive delta on the first live
   * tick back and re-arms the stint.
   */
  fuelCalloutLastFuelLevel: number | null;
  /**
   * Smallest count already announced this stint, or `null` when none has
   * been. A sample only emits when its count is strictly below this
   * (descending crossings only; multi-count drops speak just the current
   * count). Cleared by a refuel — the new stint re-arms every count.
   * Preserved across `wipeStateForReplay` so a replay glance mid-race can't
   * repeat a count; a genuine session change still clears it.
   */
  fuelCalloutLastAnnouncedCount: number | null;
  /**
   * True once the enough-fuel reassurance (`fuel.lapsLeft.raceCovered`,
   * issue #880) has been emitted for the current stint. Cleared by a refuel
   * and by any later REAL warning emission (a burn-rate spike arc speaks
   * warning → reassurance again once coverage recovers). Preserved across
   * `wipeStateForReplay` alongside the announce floor so a replay glance
   * can't repeat the reassurance; a genuine session change clears it.
   */
  fuelCalloutRaceCoveredAnnounced: boolean;

  // ── Lifecycle ───────────────────────────────────────────────────────────
  // `driver.firstOnTrack` is tracked on the translator instance, not here —
  // it's a connection-lifetime milestone that must survive the per-tick
  // state resets the replay guard performs (see `diffFirstOnTrack` in
  // `translator.ts`).
  lifecycleInitialized: boolean;
  lastSessionNum: number | null;
  lastEngineRunning: boolean;
  lastLap: number;

  // ── Lap completion (issue #555) ─────────────────────────────────────────
  // Tracks `LapCompleted` (counter) and `LapBestLapTime` across ticks so the
  // diff can emit one `lap.completed` per real lap completion and decide if
  // the lap was the new session best. Seeded silently on first tick — without
  // it, connecting mid-session would synthesize a spurious completion event.
  // `lastLapBestLapTime` stores 0 when no valid lap has happened yet (the
  // iRacing sentinel — matches `LapBestLapTime` being unset).
  //
  // `lastLapSessionNum` is tracked independently of `lastSessionNum` (used by
  // diffLifecycle) so the lap diff can detect session boundaries on its own
  // schedule and wipe the lap-completed tracking — a fast practice PB must
  // not carry into qualifying or the race.
  lapCompletedInitialized: boolean;
  lastLapCompletedCounter: number;
  lastLapBestLapTime: number;
  lastLapSessionNum: number | null;
  /**
   * `LapLastLapTime` at the moment of the last emission. Used to detect when
   * iRacing has refreshed `LapLastLapTime` for the just-completed lap: when
   * `LapCompleted` increments, iRacing sometimes lags one or two ticks
   * before updating `LapLastLapTime`, and reading the stale prior-lap value
   * here would publish a duplicate `lap.completed` (with stale `lapTime`,
   * `isBest: false`, and `previousBest === lapTime`). Waiting until the
   * value strictly changes guarantees we publish each lap exactly once with
   * its own time.
   */
  lastEmittedLapTime: number;
  /**
   * Position baselines captured at the previous `lap.completed` emission
   * (issue #566). `0` is the sentinel for "no baseline yet" — mirroring how
   * `lastLapBestLapTime` uses `0` to mean "no prior best". Cleared by the
   * session-change reset alongside the other lap baselines so a position
   * gain in practice doesn't carry into qualifying.
   */
  lastLapPosition: number;
  lastLapClassPosition: number;
  /**
   * Timestamp (ms since epoch) when the lap diff first detected a settled
   * lap-time refresh but `ResultsPositions` had not yet caught up (issue
   * #566). The diff defers the `lap.completed` emit until standings sync,
   * but with a hard timeout (`LAP_RESULTS_SYNC_MAX_WAIT_MS`) so a stale or
   * missing `ResultsPositions` never permanently swallows a lap. `0` while
   * not pending; reset on emit and on session-change / disconnect.
   */
  lapResultsPendingSince: number;
  /**
   * Lap counter value (`LapCompleted`) at the most recent position change
   * (issue #569). Used to compute `lapsSincePositionChange` on the
   * `lap.completed` payload, which the race-status callout uses to drive its
   * every-3-laps cadence. `-1` until the first change is detected — before
   * then the diff omits `lapsSincePositionChange` from the payload (no
   * baseline yet).
   *
   * "Effective" position drives the change detection: class in multi-class
   * series, overall in single-class. The counter resets on every detected
   * change so the every-3 cadence restarts cleanly when the driver gains or
   * loses a place.
   */
  lastPositionChangeLap: number;
  /**
   * Once-per-session latch for `race.finished` (issue #569). Set the first
   * time `lap.completed` fires in a race session after iRacing raised the
   * checkered flag. Cleared on session change / disconnect so a later race
   * session re-arms the latch.
   */
  raceFinishedFired: boolean;
};

export function createInitialState(): TranslatorState {
  return {
    pitLaneInitialized: false,
    lastOnPitRoad: false,
    lapStartedFromPits: false,
    lastInPitStall: false,
    approachExitingSuppressed: false,
    approachAlertFired: false,
    pitApproachCooldownUntil: 0,
    pitBoxMarksSpoken: new Set(),
    pitBoxEntrySeeded: false,

    cornerLeadPrevPct: null,
    cornerSpoken: new Set(),
    cornerMarkersKey: "",
    cornerMarkers: null,

    flagStateInitialized: false,
    activeFlags: new Set(),
    lastYellowScope: null,
    lastAnyYellow: false,
    yellowClearPendingSince: null,
    furledPendingAt: 0,
    furledAnnounced: false,
    flagLastLapCompleted: null,
    flagLastCrossedAt: 0,
    checkeredPendingCross: false,
    whiteLastLapFired: false,
    playerFinalLapStarted: false,
    whiteRaisedAt: 0,

    paceLapInitialized: false,
    lastTickInParadeLaps: false,
    paceLapArmed: false,
    paceLapAccrued: 0,
    paceLapLastDistPct: 0,
    paceLapSourceCarIdx: null,
    paceLapPaceCarIdx: null,
    onePaceLapToGoFired: false,

    rollingStartInitialized: false,
    lastInParadeLaps: false,

    pitsOpenInitialized: false,
    lastPitsOpen: false,

    startLightInitialized: false,
    lastStartLightBits: 0,
    startCountdownCeiling: null,
    startCountdownFired: new Set(),
    startCountdownObserved: false,

    toggleStateInitialized: false,
    lastPitSvFlags: 0,
    lastPitSvCompound: 0,
    lastLimiterActive: false,
    lastP2PActive: false,
    lastDrsActive: false,
    fuelDebounce: { pendingAt: 0, lastSeen: false },
    windshieldDebounce: { pendingAt: 0, lastSeen: false },
    fastRepairDebounce: { pendingAt: 0, lastSeen: false },
    lastSeenTireFlags: 0,
    lastTireChangeAt: 0,

    pitReadbackInitialized: false,
    pitReadbackPrevOnPitRoad: false,
    pitReadbackExitFireAt: 0,
    pitActionCooldownUntil: 0,
    pitReadbackPreStartFireAt: 0,
    lastTickInPreStart: false,

    trackWetnessInitialized: false,
    lastTrackWetness: TrackWetness.Unknown,

    pitStatusInitialized: false,
    lastPitSvStatus: 0, // PitSvStatus.None

    limiterInitialized: false,
    lastOnPitRoadForLimiter: false,
    lastLimiterOnPitRoad: false,
    speedingWarnedAt: 0,

    lastIncidentCount: -1,
    offTrackStartedAt: 0,
    offTrackWarnedThisExcursion: false,
    materialHistory: [],
    offTrackPending: false,
    pendingIncidentType: null,
    pendingIncidentTypeAt: 0,
    incidentBurstType: null,
    incidentBurstDelta: 0,
    incidentBurstFirstAt: 0,
    incidentBurstLatestAt: 0,

    damageInitialized: false,
    damageBaseline: false,
    damagePendingAt: 0,
    damagePendingValue: false,

    overtakeInitialized: false,
    lastPosition: -1,
    pendingOvertakePos: -1,
    pendingOvertakeTime: 0,
    lastConfirmedOvertakeCarIdx: -1,
    pendingOvertakeFromRetirement: false,
    lastCalledPosition: -1,
    pendingOvertakePrevPos: 0,
    pendingOvertakePrevClassPos: 0,
    lastClassPosition: 0,
    pendingLossPos: -1,
    pendingLossTime: 0,
    pendingLossPrevPos: 0,
    pendingLossPrevClassPos: 0,
    trackLengthMeters: null,
    trackLengthKey: "",

    gapTraces: [],
    gapAheadIdx: -1,
    gapBehindIdx: -1,
    gapLiveAhead: null,
    gapLiveBehind: null,
    gapLastCheckpointAhead: null,
    gapLastCheckpointBehind: null,
    gapRateEmaAhead: null,
    gapRateEmaBehind: null,
    gapRateSamplesAhead: 0,
    gapRateSamplesBehind: 0,
    gapLastCheckpointProgress: -1,
    gapLapSampleAhead: null,
    gapLapSampleBehind: null,
    gapPrevLapDirectionAhead: null,
    gapPrevLapDirectionBehind: null,
    gapAnnouncedDirectionAhead: null,
    gapAnnouncedDirectionBehind: null,
    gapThresholdArmedAhead: false,
    gapThresholdArmedBehind: false,
    gapLastLapCompleted: -1,

    positionLastKnownScores: [],
    positionFrozen: new Set(),
    lastFrozenPositions: [],
    positionPrevScore: [],
    positionJustReleased: new Set(),

    radarState: "clear",

    fuelCalloutLastDistPct: null,
    fuelCalloutLastSampledLap: -1,
    fuelCalloutLastFuelLevel: null,
    fuelCalloutLastAnnouncedCount: null,
    fuelCalloutRaceCoveredAnnounced: false,

    lifecycleInitialized: false,
    lastSessionNum: null,
    lastEngineRunning: false,
    lastLap: -1,

    lapCompletedInitialized: false,
    lastLapCompletedCounter: -1,
    lastLapBestLapTime: 0,
    lastLapSessionNum: null,
    lastEmittedLapTime: 0,
    lastLapPosition: 0,
    lastLapClassPosition: 0,
    lapResultsPendingSince: 0,
    lastPositionChangeLap: -1,
    raceFinishedFired: false,
  };
}
