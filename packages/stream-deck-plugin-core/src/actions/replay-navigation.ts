import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import replayNavigationTemplate from "../../icons/replay-navigation.svg";

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const RED = "#e74c3c";
const YELLOW = "#f1c40f";
const GRAY = "#888888";

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
 * Label configuration for each navigation action (line1 bold, line2 subdued)
 */
const REPLAY_NAVIGATION_LABELS: Record<NavigationAction, { line1: string; line2: string }> = {
  "next-session": { line1: "NEXT", line2: "SESSION" },
  "prev-session": { line1: "PREV", line2: "SESSION" },
  "next-lap": { line1: "NEXT", line2: "LAP" },
  "prev-lap": { line1: "PREV", line2: "LAP" },
  "next-incident": { line1: "NEXT", line2: "INCIDENT" },
  "prev-incident": { line1: "PREV", line2: "INCIDENT" },
  "jump-to-start": { line1: "GO TO", line2: "START" },
  "jump-to-end": { line1: "GO TO", line2: "END" },
  "set-play-position": { line1: "SET", line2: "POSITION" },
  "search-session-time": { line1: "SEARCH", line2: "TIME" },
  "erase-tape": { line1: "ERASE", line2: "TAPE" },
};

/**
 * SVG icon content for each navigation action
 */
const REPLAY_NAVIGATION_ICONS: Record<NavigationAction, string> = {
  // Next Session: Right arrow + vertical bar (skip-next)
  "next-session": `
    <polygon points="24,14 44,26 24,38" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <line x1="48" y1="14" x2="48" y2="38" stroke="${WHITE}" stroke-width="2.5" stroke-linecap="round"/>`,

  // Previous Session: Left arrow + vertical bar (skip-prev)
  "prev-session": `
    <polygon points="48,14 28,26 48,38" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <line x1="24" y1="14" x2="24" y2="38" stroke="${WHITE}" stroke-width="2.5" stroke-linecap="round"/>`,

  // Next Lap: Circular arrow clockwise + "L"
  "next-lap": `
    <path d="M 42,18 A 12,12 0 1,1 30,14" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round"/>
    <polygon points="42,13 42,23 48,18" fill="${GREEN}"/>
    <text x="36" y="30" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="10" font-weight="bold">L</text>`,

  // Previous Lap: Circular arrow counter-clockwise + "L"
  "prev-lap": `
    <path d="M 30,18 A 12,12 0 1,0 42,14" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round"/>
    <polygon points="30,13 30,23 24,18" fill="${GREEN}"/>
    <text x="36" y="30" text-anchor="middle" dominant-baseline="central"
          fill="${GREEN}" font-family="Arial, sans-serif" font-size="10" font-weight="bold">L</text>`,

  // Next Incident: Warning triangle + right arrow
  "next-incident": `
    <polygon points="30,14 20,34 40,34" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linejoin="round"/>
    <text x="30" y="30" text-anchor="middle" dominant-baseline="central"
          fill="${YELLOW}" font-family="Arial, sans-serif" font-size="12" font-weight="bold">!</text>
    <polyline points="46,20 54,26 46,32" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Previous Incident: Warning triangle + left arrow
  "prev-incident": `
    <polygon points="42,14 52,34 32,34" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linejoin="round"/>
    <text x="42" y="30" text-anchor="middle" dominant-baseline="central"
          fill="${YELLOW}" font-family="Arial, sans-serif" font-size="12" font-weight="bold">!</text>
    <polyline points="26,20 18,26 26,32" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,

  // Jump to Start: Double left arrow + vertical bar
  "jump-to-start": `
    <line x1="20" y1="14" x2="20" y2="38" stroke="${WHITE}" stroke-width="2.5" stroke-linecap="round"/>
    <polygon points="40,14 26,26 40,38" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <polygon points="52,14 38,26 52,38" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>`,

  // Jump to End: Double right arrow + vertical bar
  "jump-to-end": `
    <polygon points="20,14 34,26 20,38" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <polygon points="32,14 46,26 32,38" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <line x1="52" y1="14" x2="52" y2="38" stroke="${WHITE}" stroke-width="2.5" stroke-linecap="round"/>`,

  // Set Play Position: Crosshair/target
  "set-play-position": `
    <circle cx="36" cy="26" r="10" fill="none" stroke="${GRAY}" stroke-width="2"/>
    <circle cx="36" cy="26" r="3" fill="${GRAY}"/>
    <line x1="36" y1="12" x2="36" y2="18" stroke="${GRAY}" stroke-width="2" stroke-linecap="round"/>
    <line x1="36" y1="34" x2="36" y2="40" stroke="${GRAY}" stroke-width="2" stroke-linecap="round"/>
    <line x1="22" y1="26" x2="28" y2="26" stroke="${GRAY}" stroke-width="2" stroke-linecap="round"/>
    <line x1="44" y1="26" x2="50" y2="26" stroke="${GRAY}" stroke-width="2" stroke-linecap="round"/>`,

  // Search Session Time: Clock/timer
  "search-session-time": `
    <circle cx="36" cy="26" r="12" fill="none" stroke="${GRAY}" stroke-width="2"/>
    <line x1="36" y1="26" x2="36" y2="18" stroke="${GRAY}" stroke-width="2" stroke-linecap="round"/>
    <line x1="36" y1="26" x2="43" y2="29" stroke="${GRAY}" stroke-width="2" stroke-linecap="round"/>
    <line x1="36" y1="11" x2="36" y2="14" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>`,

  // Erase Tape: X/cross
  "erase-tape": `
    <line x1="24" y1="14" x2="48" y2="38" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="48" y1="14" x2="24" y2="38" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>`,
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

const ReplayNavigationSettings = z.object({
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

  const iconContent = REPLAY_NAVIGATION_ICONS[navigation] || REPLAY_NAVIGATION_ICONS["next-session"];
  const labels = REPLAY_NAVIGATION_LABELS[navigation] || REPLAY_NAVIGATION_LABELS["next-session"];

  const svg = renderIconTemplate(replayNavigationTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
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
