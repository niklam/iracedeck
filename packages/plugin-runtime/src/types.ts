/**
 * The shared types of the composition root (#1349): what a plugin shell hands
 * `startPlugin`, and each phase's handoff to the phases after it. A data
 * dependency between phases is one of these parameters, so a phase cannot run
 * before what it needs exists. Phases import from here, never from `index.ts`.
 */
import type { AudioAssetsManifest } from "@iracedeck/audio-scenarios";
import type { CalloutScript } from "@iracedeck/callout-script";
import type {
  IDeckActionHandler,
  IDeckPlatformAdapter,
  LogLocation,
  ReplaySessionStore,
  SettingsWindowCommandDeps,
  SettingsWindowController,
  SettingsWindowOpenOptions,
} from "@iracedeck/deck-core";
import type { getController } from "@iracedeck/deck-iracing";
import type { IEventBus } from "@iracedeck/event-bus";
import type { IRacingNative } from "@iracedeck/iracing-native";
import type { ILogger } from "@iracedeck/logger";
import type { SettingsStore } from "@iracedeck/settings";
import type { VoicePackInstaller, VoicePackLaunchStep, VoicePackService } from "@iracedeck/voice-packs";

/** One `adapter.registerAction` call: the UUID, the logger scope it always used, and the handler factory. */
export interface ActionRegistration {
  readonly uuid: string;
  readonly scope: string;
  readonly create: (logger: ILogger) => IDeckActionHandler;
}

/**
 * What only some hosts have (#1349) — today only Stream Deck: profiles (#736),
 * the deck-device list, the connected device type. The bootstrap tests for its
 * presence, never for a host name. Constructing one must have no side effects;
 * `start()` wires it.
 */
export interface PluginExtension {
  /** Actions only this host registers, after the shared list. */
  readonly extraActions: readonly ActionRegistration[];
  /** The connected deck's type id, for the changelog URL (#680); undefined when none is connected. */
  getConnectedDeviceType(): number | undefined;
  /** The settings window's profile buttons (#992): switch `deviceId` to a bundled profile by display name. */
  switchProfile(deviceId: string, profile: string, page?: number): void;
  /** Register the profile switcher and the device connect/disconnect listeners. Called once, by `startServices`. */
  start(): void;
  /** Re-publish the deck-device list (deduped); called before the settings window opens. */
  refreshDevices(): void;
}

/** What a plugin shell hands `startPlugin`. */
export interface PluginHost {
  readonly adapter: IDeckPlatformAdapter;
  /** `<plugin>/bin`: the bundle's directory, holding `config.json`; `../assets`, `../ui` are its siblings. */
  readonly binDir: string;
  readonly extension?: PluginExtension;
}

/** Phase 1's handoff. */
export interface Core {
  readonly host: PluginHost;
  readonly adapter: IDeckPlatformAdapter;
  readonly binDir: string;
  readonly logLocation: LogLocation;
  readonly bus: IEventBus;
  readonly controller: ReturnType<typeof getController>;
}

/** Phase 3's handoff: the native input layer, used again by window focus (phase 8) and the elevation check (phase 9). */
export interface Input {
  readonly native: IRacingNative;
}

/** Phase 4's handoff. */
export interface Audio {
  /** `<plugin>/assets/audio`, the first and highest-precedence audio root. */
  readonly rootDir: string;
  readonly featureGateLogger: ILogger;
  /** Arms the live Race Engineer / Radar gate sync (#1007); called from the settings store-ready block. */
  readonly armFeatureGateSync: () => void;
}

/**
 * The voice-pack phase's mutable state (#1104). Created BEFORE the voice-pack
 * service, so nothing the service calls back into can meet an uninitialised
 * binding — the temporal-dead-zone hazard of the old module scope is gone by
 * construction. Owned by the phase; others read it.
 */
export interface VoicePackState {
  activeManifest: AudioAssetsManifest;
  raceEngineerVoices: string[];
  driverNames: string[];
  activeScripts: ReadonlyMap<string, CalloutScript>;
  /** The last JSON each run-scoped push wrote, for content dedupe. */
  readonly lastPublished: {
    voiceList: string;
    voiceLabels: string;
    driverNames: string;
    packList: string;
    status: string;
  };
}

type VoicePackWindowCommands = Required<
  Pick<
    SettingsWindowCommandDeps,
    "refreshVoicePacks" | "installVoicePack" | "removeVoicePack" | "openDirectory" | "voicePacksPath"
  >
>;

/** Phase 5's handoff. */
export interface VoicePacks {
  readonly state: VoicePackState;
  readonly logger: ILogger;
  readonly service: VoicePackService;
  readonly installer: VoicePackInstaller;
  readonly launch: VoicePackLaunchStep;
  /** The deduped run-scoped pushes: `_raceEngineerVoices` + labels, `_driverNames`, `_voicePacks`. */
  readonly push: { raceEngineerVoices(): void; driverNames(): void; packList(): void };
  /** Re-evaluate the missing-callout-script banner (#1064). */
  reassertVoiceScriptWarning(): void;
  /** The settings window's voice-pack commands (Rescan, Install, Remove, Open folder). */
  readonly windowCommands: VoicePackWindowCommands;
  /** Ask the catalog on the way to opening the settings window (#1100). Fire-and-forget. */
  refreshCatalog(): void;
}

/** Phase 7's handoff. */
export interface Settings {
  readonly store: SettingsStore;
  readonly replayStore: ReplaySessionStore;
  openSettingsWindow(options?: SettingsWindowOpenOptions): ReturnType<SettingsWindowController["open"]>;
}
