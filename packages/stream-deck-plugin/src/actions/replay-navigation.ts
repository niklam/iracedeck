import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
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
import z from "zod";

import {
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

/** ReplayPosMode.Begin — position from beginning of replay */
const REPLAY_POS_BEGIN = 0;

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
 * Label configuration for each navigation action (mainLabel prominent, subLabel subdued)
 */
const REPLAY_NAVIGATION_LABELS: Record<NavigationAction, { mainLabel: string; subLabel: string }> = {
  "next-session": { mainLabel: "NEXT", subLabel: "SESSION" },
  "prev-session": { mainLabel: "PREVIOUS", subLabel: "SESSION" },
  "next-lap": { mainLabel: "LAP", subLabel: "NEXT" },
  "prev-lap": { mainLabel: "LAP", subLabel: "PREVIOUS" },
  "next-incident": { mainLabel: "NEXT", subLabel: "INCIDENT" },
  "prev-incident": { mainLabel: "PREVIOUS", subLabel: "INCIDENT" },
  "jump-to-start": { mainLabel: "START", subLabel: "JUMP TO" },
  "jump-to-end": { mainLabel: "END", subLabel: "JUMP TO" },
  "set-play-position": { mainLabel: "SET", subLabel: "POSITION" },
  "search-session-time": { mainLabel: "SEARCH", subLabel: "TIME" },
  "erase-tape": { mainLabel: "ERASE", subLabel: "TAPE" },
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
export function generateReplayNavigationSvg(settings: { navigation: NavigationAction }): string {
  const { navigation } = settings;

  const iconSvg = NAVIGATION_ICONS[navigation] || NAVIGATION_ICONS["next-session"];
  const labels = REPLAY_NAVIGATION_LABELS[navigation] || REPLAY_NAVIGATION_LABELS["next-session"];

  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
  });

  return svgToDataUri(svg);
}

/**
 * Replay Navigation
 * Provides navigation controls during replays (jump to sessions, laps, incidents,
 * specific positions, and other replay navigation) via iRacing SDK commands.
 */
@action({ UUID: "com.iracedeck.sd.core.replay-navigation" })
export class ReplayNavigation extends ConnectionStateAwareAction<ReplayNavigationSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("ReplayNavigation"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<ReplayNavigationSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<ReplayNavigationSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ReplayNavigationSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<ReplayNavigationSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeNavigation(settings);
  }

  override async onDialDown(ev: DialDownEvent<ReplayNavigationSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeNavigation(settings);
  }

  override async onDialRotate(ev: DialRotateEvent<ReplayNavigationSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);
    const pair = DIRECTIONAL_PAIRS[settings.navigation];

    if (!pair) return;

    const navigation = ev.payload.ticks > 0 ? pair.next : pair.prev;
    this.executeNavigation({ ...settings, navigation });
  }

  private parseSettings(settings: unknown): ReplayNavigationSettings {
    const parsed = ReplayNavigationSettings.safeParse(settings);

    return parsed.success ? parsed.data : ReplayNavigationSettings.parse({});
  }

  private executeNavigation(settings: ReplayNavigationSettings): void {
    const replay = getCommands().replay;

    switch (settings.navigation) {
      case "next-session": {
        const success = replay.nextSession();
        this.logger.info("Next session executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-session": {
        const success = replay.prevSession();
        this.logger.info("Previous session executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "next-lap": {
        const success = replay.nextLap();
        this.logger.info("Next lap executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-lap": {
        const success = replay.prevLap();
        this.logger.info("Previous lap executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "next-incident": {
        const success = replay.nextIncident();
        this.logger.info("Next incident executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-incident": {
        const success = replay.prevIncident();
        this.logger.info("Previous incident executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "jump-to-start": {
        const success = replay.goToStart();
        this.logger.info("Jump to start executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "jump-to-end": {
        const success = replay.goToEnd();
        this.logger.info("Jump to end executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "set-play-position": {
        const success = replay.setPlayPosition(REPLAY_POS_BEGIN, settings.frameNumber);
        this.logger.info("Set play position executed");
        this.logger.debug(`Result: ${success}, frameNumber: ${settings.frameNumber}`);
        break;
      }
      case "search-session-time": {
        const success = replay.searchSessionTime(settings.sessionNum, settings.sessionTimeMs);
        this.logger.info("Search session time executed");
        this.logger.debug(
          `Result: ${success}, sessionNum: ${settings.sessionNum}, sessionTimeMs: ${settings.sessionTimeMs}`,
        );
        break;
      }
      case "erase-tape": {
        const success = replay.eraseTape();
        this.logger.info("Erase tape executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<ReplayNavigationSettings> | DidReceiveSettingsEvent<ReplayNavigationSettings>,
    settings: ReplayNavigationSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateReplayNavigationSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
