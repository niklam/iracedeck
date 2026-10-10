/**
 * Template Context Builder
 *
 * Answers template variable lookups from iRacing telemetry and session data.
 * Used by resolveTemplate() to hydrate {{variable}} placeholders (`display`)
 * and {{= expression }} calculations (`raw`).
 *
 * The context is lazy (#1339): it answers one dot-notation path at a time and
 * builds a namespace (the path's first segment) only when a path in it is first
 * asked for, keeping it for the rest of that context's life. A template reads two
 * or three variables, so one frame's context costs only the namespaces its
 * templates touch, instead of materialising every driver field and a flatten of
 * all telemetry and the whole session YAML.
 */
import type { ExpressionValue, VariableLookupResult } from "./expression-evaluator.js";
import { extractQualifyResults } from "./grid-utils.js";
import { estimateIRatingChanges, type IRatingEstimates, resolveIRatingEstimateOrder } from "./irating-utils.js";
import { classPositionFromOrder } from "./position-utils.js";
import type { SDKController } from "./SDKController.js";
import { formatSessionClock, resolveLapsRemaining, resolveShownTimeRemainingS } from "./session-limit.js";
import { findNearestCarOnTrack } from "./track-utils.js";
import type { SessionInfo, TelemetryData } from "./types.js";

/** Value type for raw template-context entries. */
export type TemplateValue = ExpressionValue;

/**
 * The raw value at a path. `found: false` means the context has no such path,
 * which an expression reports as an unknown variable; `found: true` with an
 * `undefined` value is a path that exists but holds nothing. The evaluator's
 * lookup result under the context's name: one type, so the two cannot drift.
 */
export type TemplateLookup = VariableLookupResult;

/**
 * Template variables, answered one dot-notation path at a time
 * (e.g. "self.name", "telemetry.Speed"). Both methods are plain closures, so a
 * detached `context.display` still works.
 */
export interface TemplateContext {
  /** Display-formatted string a plain {{path}} renders, or undefined when the path is absent. */
  display(path: string): string | undefined;
  /** Full-precision value a {{= expression }} reads. */
  raw(path: string): TemplateLookup;
}

/**
 * Where the live race order comes from: the order itself, or a provider called
 * at most once per context, and only when a namespace that needs it is built.
 * `SDKController` passes a provider, because the translator computes the
 * canonical order when asked.
 */
export type LivePositionsSource = number[] | null | (() => number[] | null);

/**
 * @internal Exported for the test-only reference builder
 *
 * A display/raw map pair for one context namespace.
 */
export interface FieldMaps {
  display: Record<string, string>;
  raw: Record<string, TemplateValue>;
}

const NOT_FOUND: TemplateLookup = Object.freeze({ found: false });

/**
 * A context over two prebuilt maps, keyed by full path. Own keys only, so
 * prototype names such as "constructor" are absent rather than inherited.
 * Used for each eager namespace, for the empty fallback context, and by tests.
 */
export function templateContextFromMaps(
  display: Record<string, string>,
  raw: Record<string, TemplateValue> = {},
): TemplateContext {
  return {
    display: (path) => (Object.hasOwn(display, path) ? display[path] : undefined),
    raw: (path) => (Object.hasOwn(raw, path) ? { found: true, value: raw[path] } : NOT_FOUND),
  };
}

/** A namespace with no keys: every path in it is absent. */
const EMPTY_NAMESPACE = templateContextFromMaps({});

/**
 * Raw driver field values — numeric fields stay numbers until display formatting.
 * `undefined` means "unavailable": display renders "", raw omits the key.
 */
type DriverFieldValue = string | number | undefined;

/**
 * Shared fields available for all driver groups.
 *
 * Must stay a `type` alias (not `interface`): only aliases get the implicit
 * index signature needed for assignability to `Record<string, DriverFieldValue>`
 * in `fieldsToMaps`.
 */
type DriverFields = {
  name: string;
  first_name: string;
  last_name: string;
  abbrev_name: string;
  car_number: string;
  position: number | undefined;
  class_position: number | undefined;
  lap: number | undefined;
  laps_completed: number | undefined;
  irating: number | undefined;
  irating_change: number | undefined;
  irating_new: number | undefined;
  license: string;
};

/**
 * Self driver extends DriverFields with additional player-specific data.
 */
type SelfDriverFields = DriverFields & {
  incidents: number | undefined;
};

/**
 * One entry from the session YAML's driver roster. String fields iRacing can
 * leave blank (parsed to null) — e.g. AbbrevName for AI drivers — or emit as
 * unquoted numeric scalars (parsed to number), so consumers must normalize
 * through `yamlString` (#869).
 */
export interface DriverEntry {
  CarIdx: number;
  UserName: string | number | null;
  AbbrevName: string | number | null;
  CarNumber: string | number | null;
  IRating: number;
  LicString: string | number | null;
  IsSpectator: number;
  CarIsPaceCar: number;
}

/** Normalizes a YAML scalar to a string: blank (null/undefined) → "", numbers → digits. */
function yamlString(value: string | number | null | undefined): string {
  return value == null ? "" : String(value);
}

/** @internal Exported for the test-only reference builder */
export const EMPTY_DRIVER_FIELDS: Readonly<DriverFields> = {
  name: "",
  first_name: "",
  last_name: "",
  abbrev_name: "",
  car_number: "",
  position: undefined,
  class_position: undefined,
  lap: undefined,
  laps_completed: undefined,
  irating: undefined,
  irating_change: undefined,
  irating_new: undefined,
  license: "",
};

const EMPTY_SELF_FIELDS: SelfDriverFields = {
  ...EMPTY_DRIVER_FIELDS,
  incidents: undefined,
};

/**
 * Field names that are integers (0/1) but represent boolean values.
 * These get converted to "Yes"/"No" instead of "0"/"1".
 */
const BOOLEAN_INT_FIELDS = new Set([
  "IsOnTrack",
  "IsOnTrackCar",
  "IsReplayPlaying",
  "IsInGarage",
  "IsDiskLoggingEnabled",
  "IsDiskLoggingActive",
  "PlayerCarDryTireSetAvailable",
  "DriverMarker",
  "PushToPass",
  "PushToTalk",
  "OnPitRoad",
  "PitstopActive",
  "PlayerCarInPitStall",
]);

/** One telemetry or session-info leaf, formatted for both kinds of placeholder. */
interface LeafEntry {
  display: string;
  raw: TemplateLookup;
}

/**
 * @internal Exported for testing
 *
 * The per-leaf rule for `telemetry.*` and `sessionInfo.*`: display-formatted
 * string (floats rounded to 2 decimals, booleans and known boolean-semantic
 * integers as Yes/No) and full-precision raw value (numbers stay numbers —
 * including BOOLEAN_INT_FIELDS, which stay 0/1 — booleans stay booleans, strings
 * stay strings). `key` is the leaf's own segment. Returns undefined for what is
 * not a leaf: arrays, objects, null and undefined.
 *
 * This is the rule the pre-#1339 `flattenContext` applied while flattening the
 * whole object; the reference copy of that flatten in
 * `template-context-reference.test-helper.ts` is what the equivalence test
 * holds it to.
 */
export function formatLeaf(key: string, value: unknown): LeafEntry | undefined {
  if (value === null || value === undefined || typeof value === "object") return undefined;

  if (typeof value === "boolean") {
    return { display: value ? "Yes" : "No", raw: { found: true, value } };
  }

  if (typeof value === "number") {
    let display: string;

    if (BOOLEAN_INT_FIELDS.has(key) && (value === 0 || value === 1)) {
      display = value === 1 ? "Yes" : "No";
    } else {
      display = Number.isInteger(value) ? String(value) : value.toFixed(2);
    }

    return { display, raw: { found: true, value } };
  }

  if (typeof value === "string") {
    return { display: value, raw: { found: true, value } };
  }

  // Exotic primitive (e.g. bigint): display only — not a valid expression value.
  return { display: String(value), raw: NOT_FOUND };
}

/**
 * Walks `root` along a dot-separated path and formats the leaf it ends at.
 *
 * Mirrors what flattening the whole object used to expose, one path at a time:
 * every step must be an own key (so prototype names are absent), a path through
 * or ending at an array is absent, and one ending at an object, null or undefined
 * is absent. `excludePrefix` is checked against EVERY segment, not only the
 * first, because the flatten skipped matching keys at every depth.
 *
 * Splitting on "." assumes no key in the source contains a dot — the flatten
 * would have produced such a key as one path segment the walk cannot address.
 * None does: iRacing's telemetry names are identifiers, and a scan of 91
 * captured session-info documents (198k keys) found no key with a dot (#1339).
 */
function leafAt(root: object, path: string, excludePrefix?: string): LeafEntry | undefined {
  let current: object = root;
  let start = 0;

  for (;;) {
    const dot = path.indexOf(".", start);
    const key = dot < 0 ? path.slice(start) : path.slice(start, dot);

    if (excludePrefix && key.startsWith(excludePrefix)) return undefined;

    if (!Object.hasOwn(current, key)) return undefined;

    const value = (current as Record<string, unknown>)[key];

    if (dot < 0) return formatLeaf(key, value);

    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

    current = value;
    start = dot + 1;
  }
}

/** A namespace answered by walking a source object per lookup — no flatten, no memo. */
function walkingNamespace(root: object | null, excludePrefix?: string): TemplateContext {
  if (!root) return EMPTY_NAMESPACE;

  return {
    display: (path) => leafAt(root, path, excludePrefix)?.display,
    raw: (path) => leafAt(root, path, excludePrefix)?.raw ?? NOT_FOUND,
  };
}

/**
 * Builds the full template context from current SDK state.
 */
export function buildTemplateContext(sdkController: SDKController): TemplateContext {
  const telemetry = sdkController.getCurrentTelemetry();
  const sessionInfo = sdkController.getSessionInfo();

  return buildTemplateContextFromData(telemetry, sessionInfo, () => sdkController.getLiveRacePositions());
}

/**
 * Converts a raw driver fields record into the display/raw map pair.
 * Display keeps every key (null/undefined render ""); raw omits null/undefined
 * keys so expressions referencing them fail as unknown variables (rendering "").
 * Runtime nulls from YAML session data are treated like undefined.
 */
/** Fields whose display form is the signed, rounded integer (+31 / -15 / 0). */
const SIGNED_INT_DISPLAY_FIELDS = new Set(["irating_change"]);

/** @internal Exported for the test-only reference builder */
export function fieldsToMaps(fields: Record<string, DriverFieldValue>): FieldMaps {
  const display: Record<string, string> = {};
  const raw: Record<string, TemplateValue> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value != null && typeof value === "number" && SIGNED_INT_DISPLAY_FIELDS.has(key)) {
      const rounded = Math.round(value);
      display[key] = rounded > 0 ? `+${rounded}` : String(rounded);
    } else {
      display[key] = value != null ? String(value) : "";
    }

    if (value != null) {
      raw[key] = value;
    }
  }

  return { display, raw };
}

/** A namespace over one prebuilt display/raw pair. */
function mapsNamespace(maps: FieldMaps): TemplateContext {
  return templateContextFromMaps(maps.display, maps.raw);
}

/**
 * Builds the namespace for one relative-driver group (`track_ahead`,
 * `race_behind`, `focused`, …). A null driver — no car in that slot — yields
 * the empty field set, so every key renders "".
 */
function driverNamespace(
  driver: DriverEntry | null,
  telemetry: TelemetryData | null,
  inputs: DriverInputs,
): TemplateContext {
  return mapsNamespace(
    fieldsToMaps(
      driver
        ? buildDriverFields(driver, telemetry, inputs.order, inputs.playerCarIdx, inputs.estimates)
        : { ...EMPTY_DRIVER_FIELDS },
    ),
  );
}

/**
 * The parts of the context that are a pure function of the session info. Shared
 * by every context built from the same session-info object.
 */
interface SessionInfoParts {
  readonly drivers: DriverEntry[];
  readonly playerCarIdx: number;
  /** The `track` namespace, built on the first `track.*` lookup. */
  track: TemplateContext | undefined;
}

/**
 * Session-info parts memoised on the identity of the parsed session-info object.
 * `IRacingSDK.getSessionInfo()` returns the same object until iRacing bumps
 * `SessionInfoUpdate` and a new one after, so the identity IS the session-info
 * version, and a frame-to-frame rebuild with unchanged session info reuses these.
 * A WeakMap, so a superseded session-info object (a long session parses many)
 * is not kept alive by its entry. That makes it a contract on callers: hand a
 * new object for every session-info version and never mutate one in place.
 * Nothing in the repo does — `IRacingSDK` re-parses on `SessionInfoUpdate`, and
 * the scenario harness's mock replaces its object rather than patching it.
 */
const sessionInfoPartsMemo = new WeakMap<object, SessionInfoParts>();

/**
 * The parts with no session info: no drivers, no player. Shared by every such
 * context and frozen, so nothing can memoise into it; the blank `track`
 * namespace is its own constant below.
 */
const NO_SESSION_INFO_PARTS: SessionInfoParts = Object.freeze({
  drivers: [],
  playerCarIdx: -1,
  track: undefined,
});

/** The `track` namespace with no session info: blank track names. */
const NO_SESSION_INFO_TRACK: TemplateContext = (() => {
  const fields = buildTrackFields(null);

  return templateContextFromMaps(fields, fields);
})();

function sessionInfoParts(sessionInfo: SessionInfo | null): SessionInfoParts {
  if (!sessionInfo) return NO_SESSION_INFO_PARTS;

  let parts = sessionInfoPartsMemo.get(sessionInfo);

  if (!parts) {
    parts = {
      drivers: extractDrivers(sessionInfo),
      playerCarIdx: extractPlayerCarIdx(sessionInfo),
      track: undefined,
    };
    sessionInfoPartsMemo.set(sessionInfo, parts);
  }

  return parts;
}

/**
 * The inputs every driver namespace (and `session`, for the SOF) shares:
 * computed once per context, on the first namespace that needs them.
 */
interface DriverInputs {
  drivers: DriverEntry[];
  playerCarIdx: number;
  /** The canonical live race order, in race sessions only. */
  order: number[] | undefined;
  estimates: IRatingEstimates | undefined;
}

function resolveDriverInputs(
  telemetry: TelemetryData | null,
  sessionInfo: SessionInfo | null,
  livePositions: LivePositionsSource | undefined,
): DriverInputs {
  const { drivers, playerCarIdx } = sessionInfoParts(sessionInfo);
  const livePositionsNow = typeof livePositions === "function" ? livePositions() : livePositions;

  // SINGLE SOURCE OF TRUTH for race position: the translator's canonical live
  // race order (1-based, indexed by carIdx) — the same order Session Info derives
  // from. The template NEVER computes its own order. Race sessions use the
  // injected order; otherwise (non-race, or before it's available) every prefix
  // falls back per-car to iRacing's official CarIdxPosition. One coherent order
  // means a strict 1..N ranking, so neighbour selection can't hit duplicate
  // ranks (issue #710). See @.claude/rules/race-positions.md.
  const sessionType = getCurrentSession(sessionInfo, telemetry)?.SessionType as string | undefined;
  const liveOrder = livePositionsNow && livePositionsNow.length > 0 ? livePositionsNow : undefined;
  const order = sessionType === "Race" ? liveOrder : undefined;

  // Estimated iRating change per car ("if the race ended now", #268) — the
  // order input is widened beyond the position `order` above (#872): qualifying
  // and race pre-green resolve through the official counters / qualifying grid,
  // anchored on the player so the pre-green source holds through the green-flag
  // run to the line, while a usable live order stays authoritative. Gated on
  // telemetry: without CarIdxClass a multiclass field would be scored as one
  // combined class. Memoized inside the estimator so the O(n²) math only
  // re-runs when positions actually change.
  const estimateOrder = telemetry
    ? resolveIRatingEstimateOrder({
        sessionType,
        liveOrder,
        officialPositions: telemetry.CarIdxPosition as number[] | undefined,
        qualifyResults: extractQualifyResults(sessionInfo),
        playerCarIdx,
      })
    : null;
  const estimates = estimateOrder
    ? estimateIRatingChanges({
        drivers,
        order: estimateOrder,
        carIdxClass: telemetry?.CarIdxClass as number[] | undefined,
      })
    : undefined;

  return { drivers, playerCarIdx, order, estimates };
}

/**
 * What a namespace builder reads: the context's own telemetry and session info,
 * and the shared driver inputs, computed on first call and then reused.
 */
interface NamespaceSources {
  readonly telemetry: TelemetryData | null;
  readonly sessionInfo: SessionInfo | null;
  driverInputs(): DriverInputs;
}

/**
 * @internal Exported for testing — the laziness tests spy on these.
 *
 * One builder per namespace, keyed by the path's first segment. A context calls
 * a builder the first time a path in that namespace is asked for and keeps the
 * result. Looked up through this object at call time, so a spy sees every call.
 */
export const namespaceBuilders = {
  self: (s: NamespaceSources): TemplateContext => {
    const inputs = s.driverInputs();
    const driver = inputs.drivers.find((d) => d.CarIdx === inputs.playerCarIdx);

    return mapsNamespace(
      fieldsToMaps(buildSelfFields(driver, inputs.playerCarIdx, s.telemetry, inputs.order, inputs.estimates)),
    );
  },
  track_ahead: (s: NamespaceSources): TemplateContext => {
    const inputs = s.driverInputs();

    return driverNamespace(
      findNearestDriverOnTrack(inputs.playerCarIdx, inputs.drivers, s.telemetry, "ahead"),
      s.telemetry,
      inputs,
    );
  },
  track_behind: (s: NamespaceSources): TemplateContext => {
    const inputs = s.driverInputs();

    return driverNamespace(
      findNearestDriverOnTrack(inputs.playerCarIdx, inputs.drivers, s.telemetry, "behind"),
      s.telemetry,
      inputs,
    );
  },
  race_ahead: (s: NamespaceSources): TemplateContext => {
    const inputs = s.driverInputs();

    return driverNamespace(
      findDriverByRacePosition(inputs.playerCarIdx, inputs.drivers, s.telemetry, -1, inputs.order),
      s.telemetry,
      inputs,
    );
  },
  race_behind: (s: NamespaceSources): TemplateContext => {
    const inputs = s.driverInputs();

    return driverNamespace(
      findDriverByRacePosition(inputs.playerCarIdx, inputs.drivers, s.telemetry, +1, inputs.order),
      s.telemetry,
      inputs,
    );
  },
  // `focused` can resolve to the player's own car (camera on you) — the shared
  // inputs carry playerCarIdx, so it uses the same player-authoritative fields as `self`.
  focused: (s: NamespaceSources): TemplateContext => {
    const inputs = s.driverInputs();

    return driverNamespace(findDriverByCamCarIdx(inputs.drivers, s.telemetry), s.telemetry, inputs);
  },
  // `type`, `time_remaining` and `laps_remaining` read only telemetry and the
  // current session entry. `sof` needs the driver inputs, whose live-order
  // provider runs the translator's canonical-order computation, so it is built
  // on its own first lookup: a clock-only template never asks for the order.
  session: (s: NamespaceSources): TemplateContext => {
    const clock = mapsNamespace(buildSessionFields(s.sessionInfo, s.telemetry));
    let sof: TemplateContext | undefined;
    const fieldOf = (path: string): TemplateContext => {
      if (path !== "sof") return clock;

      if (!sof) {
        const inputs = s.driverInputs();

        sof = mapsNamespace(buildSessionSofFields(inputs.playerCarIdx, inputs.estimates));
      }

      return sof;
    };

    return {
      display: (path) => fieldOf(path).display(path),
      raw: (path) => fieldOf(path).raw(path),
    };
  },
  // Session info only, so it lives with the memoised parts: built once per
  // session-info object. Without session info there is nothing to memoise on,
  // and the blank namespace is the shared constant.
  track: (s: NamespaceSources): TemplateContext => {
    if (!s.sessionInfo) return NO_SESSION_INFO_TRACK;

    const parts = sessionInfoParts(s.sessionInfo);

    if (!parts.track) {
      const fields = buildTrackFields(s.sessionInfo);

      parts.track = templateContextFromMaps(fields, fields);
    }

    return parts.track;
  },
  // `telemetry.CarIdx*` stays out, as it always has: per-car arrays are not template values.
  telemetry: (s: NamespaceSources): TemplateContext =>
    walkingNamespace(s.telemetry as Record<string, unknown> | null, "CarIdx"),
  sessionInfo: (s: NamespaceSources): TemplateContext => walkingNamespace(s.sessionInfo as object | null),
};

type NamespaceName = keyof typeof namespaceBuilders;

/**
 * @internal Exported for testing
 *
 * Builds a lazy template context over raw telemetry and session data.
 *
 * Nothing is computed here: each namespace builds on its first lookup. The
 * context keeps a reference to `telemetry` and reads it at lookup time, which
 * gives the same answers an eager build would because `IRacingSDK.getTelemetry()`
 * returns a freshly parsed object per call and nothing mutates it afterwards.
 * The live order is the one input read later than before: a provider is called
 * on the first driver or `session` lookup rather than when the context is built,
 * which for the per-frame context in `SDKController` is the same frame.
 */
export function buildTemplateContextFromData(
  telemetry: TelemetryData | null,
  sessionInfo: SessionInfo | null,
  livePositions?: LivePositionsSource,
): TemplateContext {
  let inputs: DriverInputs | undefined;
  const sources: NamespaceSources = {
    telemetry,
    sessionInfo,
    driverInputs: () => (inputs ??= resolveDriverInputs(telemetry, sessionInfo, livePositions)),
  };
  const built: Partial<Record<NamespaceName, TemplateContext>> = {};

  /** The namespace a path's first segment names, built on first use; undefined when there is none. */
  function namespaceOf(name: string): TemplateContext | undefined {
    if (!Object.hasOwn(namespaceBuilders, name)) return undefined;

    const key = name as NamespaceName;

    return (built[key] ??= namespaceBuilders[key](sources));
  }

  return {
    display: (path) => {
      const dot = path.indexOf(".");

      return dot < 0 ? undefined : namespaceOf(path.slice(0, dot))?.display(path.slice(dot + 1));
    },
    raw: (path) => {
      const dot = path.indexOf(".");

      return (dot < 0 ? undefined : namespaceOf(path.slice(0, dot))?.raw(path.slice(dot + 1))) ?? NOT_FOUND;
    },
  };
}

/**
 * @internal Exported for testing
 */
export function splitDriverName(userName: string): { firstName: string; lastName: string } {
  const trimmed = userName.trim();
  const spaceIndex = trimmed.indexOf(" ");

  if (spaceIndex === -1) return { firstName: trimmed, lastName: "" };

  return {
    firstName: trimmed.substring(0, spaceIndex),
    lastName: trimmed.substring(spaceIndex + 1),
  };
}

/**
 * @internal Exported for testing
 *
 * Finds the physically closest driver on track in a given direction.
 * Delegates to findNearestCarOnTrack with a filter that excludes pace car and spectators.
 */
export function findNearestDriverOnTrack(
  playerCarIdx: number,
  drivers: DriverEntry[],
  telemetry: TelemetryData | null,
  direction: "ahead" | "behind",
): DriverEntry | null {
  // Build a set of car indices to skip (pace car, spectators)
  const skipIndices = new Set<number>();

  for (const driver of drivers) {
    if (driver.CarIsPaceCar === 1 || driver.IsSpectator === 1) {
      skipIndices.add(driver.CarIdx);
    }
  }

  const carIdx = findNearestCarOnTrack(telemetry, playerCarIdx, direction, {
    skipIdx: (idx) => skipIndices.has(idx),
  });

  if (carIdx === null) return null;

  return drivers.find((d) => d.CarIdx === carIdx) ?? null;
}

/**
 * @internal Exported for testing
 *
 * Finds a driver by race position relative to the player.
 * offset: -1 for position ahead, +1 for position behind.
 */
export function findDriverByRacePosition(
  playerCarIdx: number,
  drivers: DriverEntry[],
  telemetry: TelemetryData | null,
  offset: number,
  positions?: number[],
): DriverEntry | null {
  const posArray = positions ?? telemetry?.CarIdxPosition;

  if (!posArray) return null;

  const playerPosition = posArray[playerCarIdx];

  if (!playerPosition || playerPosition < 1) return null;

  const targetPosition = playerPosition + offset;

  if (targetPosition < 1) return null;

  for (const driver of drivers) {
    if (posArray[driver.CarIdx] === targetPosition) {
      return driver;
    }
  }

  return null;
}

/**
 * @internal Exported for testing
 *
 * Resolves the driver the camera is currently focused on from `CamCarIdx`.
 * Returns null when no car is focused — `CamCarIdx` is undefined (no telemetry)
 * or a negative sentinel (a scenic/track cam, not a specific car) — or when the
 * index matches no driver. When the camera is on the player's own car this
 * returns the player's driver entry, which is expected.
 *
 * Unlike the track/race-relative resolvers, the pace car and spectators are
 * intentionally not filtered: a camera focus is a deliberate user selection, so
 * whatever the camera is on is the car the user wants to see.
 */
export function findDriverByCamCarIdx(drivers: DriverEntry[], telemetry: TelemetryData | null): DriverEntry | null {
  const camCarIdx = telemetry?.CamCarIdx;

  if (camCarIdx === undefined || camCarIdx < 0) return null;

  return drivers.find((d) => d.CarIdx === camCarIdx) ?? null;
}

/**
 * First strictly-positive value, or undefined. Used to skip iRacing's `0`
 * "not classified" position/class sentinel as we fall through candidate sources,
 * so an unclassified car renders blank instead of "0".
 */
function firstPositive(...values: (number | undefined)[]): number | undefined {
  return values.find((v) => typeof v === "number" && v > 0);
}

/**
 * Live class position for a car: the count of same-class cars (`CarIdxClass`)
 * ranked ahead of it in the canonical live race `order`, +1 — derived from the
 * single source of truth, exactly like the overall position. Once a live order
 * exists it is authoritative: a car not in it (rank 0) renders blank rather than
 * falling back to the official counter. The official `CarIdxClassPosition` is
 * used only when there's no live order at all (non-race / pre-init) or there's a
 * live order but no `CarIdxClass` to derive from. A non-positive official counter
 * (0 = not classified) renders blank, not "0".
 */
function resolveClassPosition(
  order: number[] | undefined,
  telemetry: TelemetryData | null,
  carIdx: number,
): number | undefined {
  if (order) {
    const carIdxClass = telemetry?.CarIdxClass as number[] | undefined;

    // With both an order and class data, the order is the sole source — a car not
    // in it stays blank, never the stale official counter.
    if (Array.isArray(carIdxClass)) {
      const derived = classPositionFromOrder(order, carIdxClass, carIdx);

      return derived > 0 ? derived : undefined;
    }

    // Live order but no class data to derive from → official class counter.
    return firstPositive(telemetry?.CarIdxClassPosition?.[carIdx]);
  }

  // No live order (non-race / pre-init) → official class counter.
  return firstPositive(telemetry?.CarIdxClassPosition?.[carIdx]);
}

/**
 * @internal Exported for the test-only reference builder
 *
 * Resolves the shared driver fields (name, car number, live overall/class
 * position, lap counts, iRating, license) for one car. Overall and class
 * position both come from the one canonical race `order` (the single source of
 * truth — live track order everywhere, including the player), falling back to
 * iRacing's official per-car counters only when no live order exists. A pace car
 * / spectator / unclassified car gets a blank position and class. `playerCarIdx`
 * only selects the player-authoritative lap counters, so `self` and
 * `focused`-on-the-player still agree (issue #700).
 */
export function buildDriverFields(
  driver: DriverEntry,
  telemetry: TelemetryData | null,
  order?: number[],
  playerCarIdx?: number,
  estimates?: IRatingEstimates,
): DriverFields {
  // Normalize the YAML string fields (#869) so the raw map keeps the key and
  // expressions like `{{= x.abbrev_name ? … : … }}` can branch on it instead
  // of dying on an unknown variable.
  const userName = yamlString(driver.UserName);
  const { firstName, lastName } = splitDriverName(userName);
  const carIdx = driver.CarIdx;
  const isPlayer = playerCarIdx !== undefined && carIdx === playerCarIdx;
  // The pace car and spectators have no race position. The relative prefixes
  // already exclude them in their finders, so this only matters for `focused`,
  // the one prefix that can be aimed at a non-competitor: render its
  // position/class blank rather than a 0 or a bogus on-track lap-order rank.
  const isCompetitor = driver.CarIsPaceCar !== 1 && driver.IsSpectator !== 1;
  // Estimated iRating change (#268): null (not in the scored field) → blank.
  const iratingChange = isCompetitor ? (estimates?.changes[carIdx] ?? null) : null;

  return {
    name: userName,
    first_name: firstName,
    last_name: lastName,
    abbrev_name: yamlString(driver.AbbrevName),
    car_number: yamlString(driver.CarNumber),
    // Single source: the canonical live order. When it exists it's authoritative
    // (a car not in it stays blank); only with no live order at all do we fall
    // back to iRacing's official CarIdxPosition. No pit-road / PlayerCar* overlay —
    // a car in the pits shows its live track position like any other.
    position: isCompetitor
      ? order
        ? firstPositive(order[carIdx])
        : firstPositive(telemetry?.CarIdxPosition?.[carIdx])
      : undefined,
    class_position: isCompetitor ? resolveClassPosition(order, telemetry, carIdx) : undefined,
    lap: (isPlayer ? telemetry?.Lap : undefined) ?? telemetry?.CarIdxLap?.[carIdx],
    laps_completed: (isPlayer ? telemetry?.LapCompleted : undefined) ?? telemetry?.CarIdxLapCompleted?.[carIdx],
    irating: driver.IRating,
    irating_change: iratingChange ?? undefined,
    // Projected post-race rating — integer, like the reference implementation.
    irating_new: iratingChange != null && driver.IRating > 0 ? Math.round(driver.IRating + iratingChange) : undefined,
    license: yamlString(driver.LicString),
  };
}

/**
 * @internal Exported for the test-only reference builder
 *
 * Builds the `self` fields: the player-aware driver field set (so `self` and
 * `focused`-on-the-player resolve identically) plus the player-only incident
 * count. Returns the empty set when the player's driver entry isn't found.
 */
export function buildSelfFields(
  driver: DriverEntry | undefined,
  playerCarIdx: number,
  telemetry: TelemetryData | null,
  order?: number[],
  estimates?: IRatingEstimates,
): SelfDriverFields {
  if (!driver) return { ...EMPTY_SELF_FIELDS };

  // Self is the player-aware per-car field set plus the player-only incident
  // count — so `self` and `focused`-on-the-player share one code path.
  return {
    ...buildDriverFields(driver, telemetry, order, playerCarIdx, estimates),
    incidents: telemetry?.PlayerCarMyIncidentCount,
  };
}

/** @internal Exported for the test-only reference builder */
export function getCurrentSession(
  sessionInfo: SessionInfo | null,
  telemetry: TelemetryData | null,
): Record<string, unknown> | undefined {
  if (!sessionInfo) return undefined;

  const sessions = (sessionInfo as Record<string, unknown>).SessionInfo as Record<string, unknown> | undefined;
  const sessionList = sessions?.Sessions as Array<Record<string, unknown>> | undefined;
  const sessionNum = telemetry?.SessionNum ?? 0;

  return sessionList?.[sessionNum];
}

/**
 * @internal Exported for the test-only reference builder
 *
 * The `session` fields other than `sof`: `type`, `laps_remaining` and
 * `time_remaining`, which read only telemetry and the current session entry.
 * `sof` is built apart by `buildSessionSofFields`, because it needs the driver
 * inputs (the live order and the iRating estimate) and the lazy context builds
 * those only when `session.sof` itself is asked for (#1339).
 */
export function buildSessionFields(sessionInfo: SessionInfo | null, telemetry: TelemetryData | null): FieldMaps {
  const currentSession = getCurrentSession(sessionInfo, telemetry);

  // Absent from raw and blank in display when the lap side does not bind —
  // the unlimited sentinel of a timed race is not a lap count (#1109).
  const lapsRemaining = resolveLapsRemaining(telemetry);
  // Blank when the time side does not bind — the unlimited sentinel of a lap
  // race is not a clock (#1186) — and 0:00 once a timed race's clock has run
  // out, the same display rule Session Info follows (#1221).
  const timeRemaining = resolveShownTimeRemainingS(telemetry);

  const type = (currentSession?.SessionType as string) ?? "";
  // time_remaining keeps the formatted clock string (M:SS, H:MM:SS from an
  // hour up — the formatter Session Info's key reads through too, #1292) in
  // BOTH maps — expressions wanting math on it should use
  // telemetry.SessionTimeRemain instead.
  const timeRemainingFormatted = formatSessionClock(timeRemaining);

  const raw: Record<string, TemplateValue> = { type, time_remaining: timeRemainingFormatted };

  if (lapsRemaining !== null) {
    raw.laps_remaining = lapsRemaining;
  }

  return {
    display: {
      type,
      laps_remaining: lapsRemaining !== null ? String(lapsRemaining) : "",
      time_remaining: timeRemainingFormatted,
    },
    raw,
  };
}

/**
 * @internal Exported for the test-only reference builder
 *
 * The `session.sof` field: Strength of Field of the player's class (#268) —
 * blank in display and absent from raw when the player isn't in a scored field
 * (non-race, no order, missing iRating, <2-car class).
 */
export function buildSessionSofFields(playerCarIdx: number | undefined, estimates?: IRatingEstimates): FieldMaps {
  const sof = playerCarIdx !== undefined && playerCarIdx >= 0 ? (estimates?.sofs[playerCarIdx] ?? null) : null;

  return {
    display: { sof: sof !== null ? String(Math.round(sof)) : "" },
    raw: sof !== null ? { sof } : {},
  };
}

/** @internal Exported for the test-only reference builder */
export function buildTrackFields(sessionInfo: SessionInfo | null): Record<string, string> {
  if (!sessionInfo) return { name: "", short_name: "" };

  const weekend = (sessionInfo as Record<string, unknown>).WeekendInfo as Record<string, unknown> | undefined;

  return {
    name: (weekend?.TrackDisplayName as string) ?? "",
    short_name: (weekend?.TrackDisplayShortName as string) ?? "",
  };
}

/** @internal Exported for the test-only reference builder */
export function extractDrivers(sessionInfo: SessionInfo | null): DriverEntry[] {
  if (!sessionInfo) return [];

  const driverInfo = (sessionInfo as Record<string, unknown>).DriverInfo as Record<string, unknown> | undefined;
  const drivers = driverInfo?.Drivers as DriverEntry[] | undefined;

  return drivers ?? [];
}

/** @internal Exported for the test-only reference builder */
export function extractPlayerCarIdx(sessionInfo: SessionInfo | null): number {
  if (!sessionInfo) return -1;

  const driverInfo = (sessionInfo as Record<string, unknown>).DriverInfo as Record<string, unknown> | undefined;

  return (driverInfo?.DriverCarIdx as number) ?? -1;
}
