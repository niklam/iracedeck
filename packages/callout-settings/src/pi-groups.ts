import type { CalloutFamily } from "./define.js";
import { AUTO_FUEL_CALLOUTS } from "./families/auto-fuel.js";
import { CAUTION_CALLOUTS } from "./families/caution.js";
import { CORNER_NAME_CALLOUTS } from "./families/corner-name.js";
import { CORNER_NAMES_TOGGLE_CALLOUTS } from "./families/corner-names-toggle.js";
import { DAMAGE_CALLOUTS } from "./families/damage.js";
import { FASTEST_LAP_CALLOUTS } from "./families/fastest-lap.js";
import { FLAG_CALLOUTS } from "./families/flag.js";
import { FUEL_CALLOUTS } from "./families/fuel.js";
import { GAP_CALLOUTS } from "./families/gaps.js";
import { INCIDENT_CALLOUTS } from "./families/incident.js";
import { LAP_TIME_CALLOUTS } from "./families/lap-time.js";
import { LIMITER_CUE_CALLOUTS } from "./families/limiter-cue.js";
import { NO_LIMITER_CALLOUTS } from "./families/no-limiter.js";
import { OPPONENT_FLAG_CALLOUTS } from "./families/opponent-flags.js";
import { OPPONENT_PIT_CALLOUTS } from "./families/opponent-pit.js";
import { OVERTAKE_CALLOUTS } from "./families/overtake.js";
import { PIT_BOX_CALLOUTS } from "./families/pit-box.js";
import { PIT_EXIT_CALLOUTS } from "./families/pit-exit.js";
import { PIT_LIMITER_CALLOUTS } from "./families/pit-limiter.js";
import { PIT_SERVICE_REQUEST_CALLOUTS } from "./families/pit-service-requests.js";
import { PIT_SPEEDING_CALLOUTS } from "./families/pit-speeding.js";
import { PIT_STATUS_CALLOUTS } from "./families/pit-status.js";
import { PIT_WINDOW_CALLOUTS } from "./families/pit-window.js";
import { POSITION_CALLOUTS } from "./families/position.js";
import { QUALIFYING_INVALIDATION_CALLOUTS } from "./families/qualifying-invalidation.js";
import { RACE_END_CALLOUTS } from "./families/race-end.js";
import { RACE_ENGINEER_TOGGLE_CALLOUTS } from "./families/race-engineer-toggle.js";
import { RACE_START_CALLOUTS } from "./families/race-start.js";
import { RACE_STATUS_CALLOUTS } from "./families/race-status.js";
import { PIT_READBACK_CALLOUTS } from "./families/readback.js";
import { ROLLING_START_CALLOUTS } from "./families/rolling-start.js";
import { SECTOR_COMPARISON_CALLOUTS } from "./families/sector-comparison.js";
import { SECTOR_START_CALLOUTS } from "./families/sector-start.js";
import { SESSION_START_CALLOUTS } from "./families/session-start.js";
import { SETUP_WARNING_CALLOUTS } from "./families/setup-warning.js";
import { SPOTTER_CALLOUTS } from "./families/spotter.js";
import { START_LIGHT_CALLOUTS } from "./families/start-light.js";
import { TELEMETRY_CONNECT_CALLOUTS } from "./families/telemetry-connect.js";
import { TIRE_WEAR_CALLOUTS } from "./families/tire-wear.js";
import { TRACK_CONDITIONS_CALLOUTS } from "./families/track-conditions.js";
import { TRAFFIC_CALLOUTS } from "./families/traffic.js";

/** One heading of callout opt-ins in the settings window's Callouts card. */
export interface CalloutPiGroup {
  readonly id: string;
  /** The heading's title. */
  readonly title: string;
  /**
   * One sentence for the driver: when the engineer speaks under this heading and what the engineer tells you. One
   * line, a full stop at the end, at most 160 characters, in plain words; never an internal name or a quoted voice
   * line (`registry.test.ts` holds the mechanical rules, the #1700 spec the style).
   */
  readonly description: string;
  /** Rendered in this order; each family's entries in their own order. */
  readonly families: readonly CalloutFamily[];
}

/** A collapsible section of the Callouts card, holding its headings (#1700). */
export interface CalloutPiSection {
  readonly id: string;
  /** The collapsible sub-header in the settings window's Callouts card. */
  readonly title: string;
  /** Rendered in this order: the order the calls come in a session or a stop. */
  readonly groups: readonly CalloutPiGroup[];
}

/**
 * The Callouts card's sections, each holding its headings, in render order (#1700). Placing a group inside a
 * section is the only way to declare one, so every heading belongs to a section; group ids unique across all
 * sections (`registry.test.ts`) make that exactly one.
 */
export const CALLOUT_PI_SECTIONS = [
  {
    id: "session-and-start",
    title: "Session & start",
    groups: [
      {
        id: "telemetry-connect",
        title: "Telemetry Connect",
        description: "When iRacing connects, the engineer does a short radio check so you know the radio is working.",
        families: [TELEMETRY_CONNECT_CALLOUTS],
      },
      {
        id: "session-start",
        title: "Session Start",
        description:
          "When a practice or qualifying session starts, the engineer briefs you on the session, the pit speed limit, the temperatures and how wet the track is.",
        families: [SESSION_START_CALLOUTS],
      },
      {
        id: "setup-warning",
        title: "Setup Warning",
        description:
          "At the start of qualifying or a race, the engineer asks you to check your setup when its name suggests it was made for the other one.",
        families: [SETUP_WARNING_CALLOUTS],
      },
      {
        id: "start-lights",
        title: "Start Lights",
        description:
          "At the start of a race, the engineer counts down to a standing start, tells you when the lights come on, and calls the go.",
        families: [START_LIGHT_CALLOUTS],
      },
      {
        id: "rolling-start",
        title: "Rolling Start",
        description:
          "During a rolling-start formation, the engineer tells you when the pace car pulls away, which car you line up behind, and when the green is one lap away.",
        families: [ROLLING_START_CALLOUTS],
      },
    ],
  },
  {
    id: "flags-and-incidents",
    title: "Flags & incidents",
    groups: [
      {
        id: "flags",
        title: "Flags",
        description: "When iRacing shows you a flag, the engineer tells you which one it is and what it means for you.",
        families: [FLAG_CALLOUTS],
      },
      {
        id: "caution",
        title: "Caution",
        description:
          "During a full-course caution in a race, the engineer talks you through it: the car to follow, the pace car, the laps to green and the restart.",
        families: [CAUTION_CALLOUTS],
      },
      {
        id: "opponent-flags",
        title: "Opponent Flags",
        description:
          "In a race, the engineer tells you when a car near you in your class picks up a penalty flag, and whether it is ahead of you or behind.",
        families: [OPPONENT_FLAG_CALLOUTS],
      },
      {
        id: "incidents",
        title: "Incidents",
        description:
          "When you run off the track, lose control, or touch or hit a wall or another car, the engineer tells you what happened.",
        families: [INCIDENT_CALLOUTS],
      },
      {
        id: "qualifying",
        title: "Qualifying",
        description:
          "In qualifying, when an incident spoils your timed lap, the engineer tells you the lap will not count and how many laps you have left.",
        families: [QUALIFYING_INVALIDATION_CALLOUTS],
      },
    ],
  },
  {
    id: "racing",
    title: "Racing",
    groups: [
      {
        id: "race",
        title: "Race",
        description:
          "In a race, the engineer gives you your grid position and the conditions at the start, your position every three laps, and your final result.",
        families: [RACE_START_CALLOUTS, RACE_STATUS_CALLOUTS, RACE_END_CALLOUTS],
      },
      {
        id: "position",
        title: "Position",
        description:
          "After a race lap that changes your position, and after each timed lap in qualifying, the engineer tells you where you stand.",
        families: [POSITION_CALLOUTS],
      },
      {
        id: "overtakes",
        title: "Overtakes",
        description:
          "In a race, when you gain or lose a place and keep it for a few seconds, the engineer tells you your new position, though not after every pass.",
        families: [OVERTAKE_CALLOUTS],
      },
      {
        id: "gaps",
        title: "Gaps",
        description:
          "In a race, the engineer tells you when the gap to the car ahead or behind starts closing or opening, and in which sectors you gain or lose time.",
        families: [GAP_CALLOUTS, SECTOR_COMPARISON_CALLOUTS],
      },
      {
        id: "spotter",
        title: "Spotter",
        description:
          "Off pit road, the engineer calls each car that comes alongside, tells you when you are clear, and keeps reminding you while one stays there.",
        families: [SPOTTER_CALLOUTS],
      },
      {
        id: "traffic",
        title: "Traffic",
        description:
          "As you near the end of pit road, the engineer tells you whether a car on track will meet you where you join, and warns you of one as you merge.",
        families: [TRAFFIC_CALLOUTS],
      },
      {
        id: "lap-time",
        title: "Lap Time",
        description:
          "As you cross the line, the engineer reads out your lap time, calls a new best lap, and tells you when someone in your class sets the race's fastest lap.",
        families: [LAP_TIME_CALLOUTS, FASTEST_LAP_CALLOUTS],
      },
    ],
  },
  {
    id: "pit-stops",
    title: "Pit stops",
    groups: [
      {
        id: "pit-window",
        title: "Pit Window",
        description: "In a race, the engineer tells you when pit road opens or closes.",
        families: [PIT_WINDOW_CALLOUTS],
      },
      {
        id: "pit-limiter",
        title: "Pit Limiter",
        description:
          "In a car with a pit limiter, the engineer warns you when it is off on pit road, still on after you leave it, or you are over the speed limit.",
        families: [PIT_LIMITER_CALLOUTS, LIMITER_CUE_CALLOUTS],
      },
      {
        id: "no-pit-limiter",
        title: "No Pit Limiter",
        description:
          "In a car without a pit limiter, the engineer reminds you of the speed limit as you enter the pit lane and warns you when you are over it.",
        families: [NO_LIMITER_CALLOUTS],
      },
      {
        id: "pit-speeding",
        title: "Pit Speeding",
        description:
          "Sounds instead of words: a tick that repeats while you are over the pit speed limit, and a beep as you cross the line where the limit ends.",
        families: [PIT_SPEEDING_CALLOUTS, PIT_EXIT_CALLOUTS],
      },
      {
        id: "pit-box",
        title: "Pit Box",
        description: "On pit road, the engineer counts down the distance to your pit box so you stop on your marks.",
        families: [PIT_BOX_CALLOUTS],
      },
      {
        id: "pit-service",
        title: "Pit Service",
        description:
          "As you head into the pits, the engineer reads back the service you have set, confirms it again after the stop, and reports your tire wear.",
        families: [PIT_READBACK_CALLOUTS, TIRE_WEAR_CALLOUTS, PIT_SERVICE_REQUEST_CALLOUTS, AUTO_FUEL_CALLOUTS],
      },
      {
        id: "pit-service-status",
        title: "Pit Service Status",
        description:
          "While you are stopped in your box, the engineer tells you when the crew starts and finishes, and when you are parked where they cannot work.",
        families: [PIT_STATUS_CALLOUTS],
      },
      {
        id: "opponent-pits",
        title: "Opponent Pits",
        description:
          "In a race, the engineer tells you when the leader, or a car on your lap within two places of you in your class, heads into the pits.",
        families: [OPPONENT_PIT_CALLOUTS],
      },
    ],
  },
  {
    id: "car-and-conditions",
    title: "Car & conditions",
    groups: [
      {
        id: "fuel",
        title: "Fuel",
        description:
          "In a race, the engineer tells you mid-lap how many full laps your fuel will last, once at each count you switch on, and when to box for fuel.",
        families: [FUEL_CALLOUTS],
      },
      {
        id: "damage",
        title: "Damage",
        description: "When your car takes enough damage to need a repair, the engineer tells you so.",
        families: [DAMAGE_CALLOUTS],
      },
      {
        id: "track-conditions",
        title: "Track Conditions",
        description: "When the track gets wetter or dries out, the engineer tells you how wet it is now.",
        families: [TRACK_CONDITIONS_CALLOUTS],
      },
    ],
  },
  {
    id: "track-guide",
    title: "Track guide",
    groups: [
      {
        id: "corner-names",
        title: "Corner Names and Sectors",
        description:
          "In practice and test sessions, the engineer names each corner just before you reach it, and each sector after the first just before it starts.",
        families: [CORNER_NAME_CALLOUTS, CORNER_NAMES_TOGGLE_CALLOUTS, SECTOR_START_CALLOUTS],
      },
    ],
  },
  {
    id: "key-acknowledgments",
    title: "Key acknowledgments",
    groups: [
      {
        id: "race-engineer-toggle",
        title: "Race Engineer Toggle",
        description:
          "When you switch the Race Engineer off or on with a key, the engineer confirms that the radio is going quiet or is back on.",
        families: [RACE_ENGINEER_TOGGLE_CALLOUTS],
      },
    ],
  },
] as const satisfies readonly CalloutPiSection[];

/** Any heading placed in a `CALLOUT_PI_SECTIONS` section, with its literal families. */
export type RegisteredCalloutPiGroup = (typeof CALLOUT_PI_SECTIONS)[number]["groups"][number];

/** Every heading, in render order: the sections' groups concatenated. */
export const CALLOUT_PI_GROUPS: readonly RegisteredCalloutPiGroup[] = CALLOUT_PI_SECTIONS.flatMap(
  (section): readonly RegisteredCalloutPiGroup[] => section.groups,
);
