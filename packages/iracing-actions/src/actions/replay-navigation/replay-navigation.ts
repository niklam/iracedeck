import {
  assembleIcon,
  CommonSettings,
  getGlobalBorderSettings,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import { SimIRacingAction } from "@iracedeck/deck-iracing";
import eraseTapeIcon from "@iracedeck/icons/replay-navigation/erase-tape.svg";
import jumpToEndIcon from "@iracedeck/icons/replay-navigation/jump-to-end.svg";
import jumpToStartIcon from "@iracedeck/icons/replay-navigation/jump-to-start.svg";
import nextIncidentIcon from "@iracedeck/icons/replay-navigation/next-incident.svg";
import nextLapIcon from "@iracedeck/icons/replay-navigation/next-lap.svg";
import nextSessionIcon from "@iracedeck/icons/replay-navigation/next-session.svg";
import prevIncidentIcon from "@iracedeck/icons/replay-navigation/prev-incident.svg";
import prevLapIcon from "@iracedeck/icons/replay-navigation/prev-lap.svg";
import prevSessionIcon from "@iracedeck/icons/replay-navigation/prev-session.svg";
import searchSessionTimeIcon from "@iracedeck/icons/replay-navigation/search-session-time.svg";
import setPlayPositionIcon from "@iracedeck/icons/replay-navigation/set-play-position.svg";
import { type ReplayCommand } from "@iracedeck/iracing-sdk";
import { pressReplayCommand, type ReplayGateCommand } from "@iracedeck/replay-engine";
import { getGlobalColors } from "@iracedeck/settings";
import z from "zod";

type NavigationAction =
  | "next-session"
  | "prev-session"
  | "next-lap"
  | "prev-lap"
  | "next-incident"
  | "prev-incident"
  | "jump-to-start"
  | "jump-to-end"
  | "set-play-position"
  | "search-session-time"
  | "erase-tape";

/**
 * Title text for each navigation action (format: "subLabel\nmainLabel")
 */
const REPLAY_NAVIGATION_TITLES: Record<NavigationAction, string> = {
  "next-session": "SESSION\nNEXT",
  "prev-session": "SESSION\nPREVIOUS",
  "next-lap": "NEXT\nLAP",
  "prev-lap": "PREVIOUS\nLAP",
  "next-incident": "INCIDENT\nNEXT",
  "prev-incident": "INCIDENT\nPREVIOUS",
  "jump-to-start": "JUMP TO\nSTART",
  "jump-to-end": "JUMP TO\nEND",
  "set-play-position": "POSITION\nSET",
  "search-session-time": "TIME\nSEARCH",
  "erase-tape": "TAPE\nERASE",
};

/**
 * SVG icon templates for each navigation action
 */
const NAVIGATION_ICONS: Record<NavigationAction, string> = {
  "next-session": nextSessionIcon,
  "prev-session": prevSessionIcon,
  "next-lap": nextLapIcon,
  "prev-lap": prevLapIcon,
  "next-incident": nextIncidentIcon,
  "prev-incident": prevIncidentIcon,
  "jump-to-start": jumpToStartIcon,
  "jump-to-end": jumpToEndIcon,
  "set-play-position": setPlayPositionIcon,
  "search-session-time": searchSessionTimeIcon,
  "erase-tape": eraseTapeIcon,
};

/**
 * Directional pairs for encoder rotation support.
 * Navigation actions in this map support clockwise=next / counter-clockwise=prev.
 * Actions not in this map ignore dial rotation.
 */
const DIRECTIONAL_PAIRS: Partial<Record<NavigationAction, { next: NavigationAction; prev: NavigationAction }>> = {
  "next-session": { next: "next-session", prev: "prev-session" },
  "prev-session": { next: "next-session", prev: "prev-session" },
  "next-lap": { next: "next-lap", prev: "prev-lap" },
  "prev-lap": { next: "next-lap", prev: "prev-lap" },
  "next-incident": { next: "next-incident", prev: "prev-incident" },
  "prev-incident": { next: "next-incident", prev: "prev-incident" },
};

const NAVIGATION_VALUES = [
  "next-session",
  "prev-session",
  "next-lap",
  "prev-lap",
  "next-incident",
  "prev-incident",
  "jump-to-start",
  "jump-to-end",
  "set-play-position",
  "search-session-time",
  "erase-tape",
] as const;

const ReplayNavigationSettings = CommonSettings.extend({
  navigation: z.enum(NAVIGATION_VALUES).default("next-session"),
  frameNumber: z.coerce.number().int().min(0).default(0),
  sessionNum: z.coerce.number().int().min(0).default(0),
  sessionTimeMs: z.coerce.number().int().min(0).default(0),
});

type ReplayNavigationSettings = z.infer<typeof ReplayNavigationSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the replay navigation action.
 */
export function generateReplayNavigationSvg(
  settings: { navigation: NavigationAction } & Partial<CommonSettings>,
): string {
  const { navigation } = settings;

  const iconSvg = NAVIGATION_ICONS[navigation] || NAVIGATION_ICONS["next-session"];
  const defaultTitle = REPLAY_NAVIGATION_TITLES[navigation] || REPLAY_NAVIGATION_TITLES["next-session"];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);

  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic });
}

/**
 * Replay Navigation
 * Provides navigation controls during replays (jump to sessions, laps, incidents,
 * specific positions, and other replay navigation) via iRacing SDK commands.
 */
export const REPLAY_NAVIGATION_UUID = "com.iracedeck.sd.core.replay-navigation" as const;

const NAVIGATION_LOG_MESSAGES: Record<ReplayNavigationSettings["navigation"], string> = {
  "next-session": "Next session executed",
  "prev-session": "Previous session executed",
  "next-lap": "Next lap executed",
  "prev-lap": "Previous lap executed",
  "next-incident": "Next incident executed",
  "prev-incident": "Previous incident executed",
  "jump-to-start": "Jump to start executed",
  "jump-to-end": "Jump to end executed",
  "set-play-position": "Set play position executed",
  "search-session-time": "Search session time executed",
  "erase-tape": "Erase tape executed",
};

/** The gate command a navigation setting sends; the SDK call stays the one the action always made. */
function navigationCommand(settings: ReplayNavigationSettings): ReplayGateCommand {
  switch (settings.navigation) {
    case "next-session":
      return { kind: "search", search: "nextSession" };
    case "prev-session":
      return { kind: "search", search: "prevSession" };
    case "next-lap":
      return { kind: "search", search: "nextLap" };
    case "prev-lap":
      return { kind: "search", search: "prevLap" };
    case "next-incident":
      return { kind: "search", search: "nextIncident" };
    case "prev-incident":
      return { kind: "search", search: "prevIncident" };
    case "jump-to-start":
      return { kind: "go-to", end: "start" };
    case "jump-to-end":
      return { kind: "go-to", end: "end" };
    case "set-play-position":
      return { kind: "jump", frame: settings.frameNumber };
    case "search-session-time": {
      const { sessionNum, sessionTimeMs } = settings;

      return {
        kind: "other",
        name: "searchSessionTime",
        send: (r) => (r as ReplayCommand).searchSessionTime(sessionNum, sessionTimeMs),
      };
    }
    case "erase-tape":
      return { kind: "other", name: "eraseTape", send: (r) => (r as ReplayCommand).eraseTape() };
  }
}

export class ReplayNavigation extends SimIRacingAction<ReplayNavigationSettings> {
  override async onWillAppear(ev: IDeckWillAppearEvent<ReplayNavigationSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<ReplayNavigationSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<ReplayNavigationSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeNavigation(settings, ev.action.id);
  }

  override async onDialDown(ev: IDeckDialDownEvent<ReplayNavigationSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeNavigation(settings);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<ReplayNavigationSettings>): Promise<void> {
    this.logger.info("Dial rotated");

    // A zero-tick turn carries no direction; without this guard it would
    // read as counter-clockwise, send a command nobody asked for and take the
    // replay cursor from a running walk (the guard Replay Control applies).
    if (ev.payload.ticks === 0) return;

    const settings = this.parseSettings(ev.payload.settings);
    const pair = DIRECTIONAL_PAIRS[settings.navigation];

    if (!pair) return;

    const navigation = ev.payload.ticks > 0 ? pair.next : pair.prev;
    // A detent is a repeat of the turn, never a second press: behind a search it waits (#1430).
    this.executeNavigation({ ...settings, navigation }, undefined, true);
  }

  private parseSettings(settings: unknown): ReplayNavigationSettings {
    const parsed = ReplayNavigationSettings.safeParse(settings);

    return parsed.success ? parsed.data : ReplayNavigationSettings.parse({});
  }

  private executeNavigation(settings: ReplayNavigationSettings, origin?: string, repeat = false): void {
    const navigation = settings.navigation;

    // Every navigation command moves the replay, so it goes through the replay
    // command gate, which takes the cursor first (a running Jump to Fastest
    // Lap walk stops and the Replay Markers landing is cleared, as for Replay
    // Control, #1334) and holds or retargets it behind a jump under way (#1430).
    const result = pressReplayCommand(navigationCommand(settings), {
      by: `replay-navigation-${navigation}`,
      origin,
      repeat,
    });
    const success = result.kind === "sent" ? result.ok : false;

    if (result.kind !== "sent") this.logger.debug(`Gate result: ${result.kind}`);

    // In a live session Jump to End leaves the replay for the car: every replay
    // consumer must read live at once, not hold the old replay frame through
    // the post-seek grace (#1230, #1324). In a saved replay it is only a seek,
    // and the controller leaves its state alone.
    if (navigation === "jump-to-end" && success) this.sdkController.noteReplayLeftForLive();

    this.logger.info(NAVIGATION_LOG_MESSAGES[navigation]);

    if (navigation === "set-play-position") {
      this.logger.debug(`Result: ${success}, frameNumber: ${settings.frameNumber}`);
    } else if (navigation === "search-session-time") {
      this.logger.debug(
        `Result: ${success}, sessionNum: ${settings.sessionNum}, sessionTimeMs: ${settings.sessionTimeMs}`,
      );
    } else {
      this.logger.debug(`Result: ${success}`);
    }
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<ReplayNavigationSettings> | IDeckDidReceiveSettingsEvent<ReplayNavigationSettings>,
    settings: ReplayNavigationSettings,
  ): Promise<void> {
    const svgDataUri = generateReplayNavigationSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateReplayNavigationSvg(settings));
  }
}
