/**
 * Race Admin Mode Definitions
 *
 * All 27 subcommands with metadata for command building, PI visibility, and icon rendering.
 */

export const RACE_ADMIN_MODES = [
  // Race Control
  "yellow",
  "black-flag",
  "dq-driver",
  "show-dqs-field",
  "show-dqs-driver",
  "clear-penalties",
  "clear-all",
  "wave-around",
  "eol",
  "pit-close",
  "pit-open",
  "pace-laps",
  "single-file-restart",
  "double-file-restart",
  // Session Management
  "advance-session",
  "grid-set",
  "grid-start",
  "track-state",
  // Driver & Chat Management
  "grant-admin",
  "revoke-admin",
  "remove-driver",
  "enable-chat-all",
  "enable-chat-driver",
  "disable-chat-all",
  "disable-chat-driver",
  "message-all",
  "rc-message",
] as const;

export type RaceAdminMode = (typeof RACE_ADMIN_MODES)[number];

export interface RaceAdminModeMeta {
  /** Chat command prefix (e.g., "!yellow"). Empty string for camera modes. */
  command: string;
  /** Whether the command requires a driver target. */
  needsDriver: boolean;
  /** Whether the command accepts an optional [message] parameter with mustache templates. */
  hasMessage: boolean;
  /** Whether the message parameter is required (e.g., /all, /rc). */
  messageRequired: boolean;
  /** IDs of extra PI setting sections to show for this mode. */
  extraSettings: string[];
  /** PI optgroup label. */
  optgroup: string;
  /** Display name in the PI dropdown. */
  displayName: string;
  /** Icon main label (bold, bottom). */
  mainLabel: string;
  /** Icon sub label (smaller, above main). */
  subLabel: string;
}

/**
 * @internal Exported for testing
 */
export const RACE_ADMIN_MODE_META: Record<RaceAdminMode, RaceAdminModeMeta> = {
  // ── Race Control ──────────────────────────────────────────────
  yellow: {
    command: "!yellow",
    needsDriver: false,
    hasMessage: true,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "Throw Yellow Flag",
    mainLabel: "YELLOW",
    subLabel: "CAUTION",
  },
  "black-flag": {
    command: "!black",
    needsDriver: true,
    hasMessage: false,
    messageRequired: false,
    extraSettings: ["penalty-section"],
    optgroup: "Race Control",
    displayName: "Black Flag Driver",
    mainLabel: "BLACK",
    subLabel: "FLAG",
  },
  "dq-driver": {
    command: "!dq",
    needsDriver: true,
    hasMessage: true,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "Disqualify Driver",
    mainLabel: "DQ",
    subLabel: "DRIVER",
  },
  "show-dqs-field": {
    command: "!showdqs",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "Show Disqualifications (Field)",
    mainLabel: "SHOW",
    subLabel: "DQS",
  },
  "show-dqs-driver": {
    command: "!showdqs",
    needsDriver: true,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "Show Disqualifications (Driver)",
    mainLabel: "SHOW",
    subLabel: "DQS",
  },
  "clear-penalties": {
    command: "!clear",
    needsDriver: true,
    hasMessage: true,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "Clear Driver Penalties",
    mainLabel: "CLEAR",
    subLabel: "PENALTY",
  },
  "clear-all": {
    command: "!clearall",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "Clear All Penalties",
    mainLabel: "CLEAR",
    subLabel: "ALL",
  },
  "wave-around": {
    command: "!waveby",
    needsDriver: true,
    hasMessage: true,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "Wave Driver Around",
    mainLabel: "WAVE",
    subLabel: "AROUND",
  },
  eol: {
    command: "!eol",
    needsDriver: true,
    hasMessage: true,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "End of Line Penalty",
    mainLabel: "EOL",
    subLabel: "PENALTY",
  },
  "pit-close": {
    command: "!pitclose",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "Close Pit Entrance",
    mainLabel: "PIT",
    subLabel: "CLOSE",
  },
  "pit-open": {
    command: "!pitopen",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "Open Pit Entrance",
    mainLabel: "PIT",
    subLabel: "OPEN",
  },
  "pace-laps": {
    command: "!pacelaps",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: ["pace-laps-section"],
    optgroup: "Race Control",
    displayName: "Adjust Pace Laps",
    mainLabel: "PACE",
    subLabel: "LAPS",
  },
  "single-file-restart": {
    command: "!restart single",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "Single-File Restart",
    mainLabel: "SINGLE",
    subLabel: "RESTART",
  },
  "double-file-restart": {
    command: "!restart double",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Race Control",
    displayName: "Double-File Restart",
    mainLabel: "DOUBLE",
    subLabel: "RESTART",
  },

  // ── Session Management ────────────────────────────────────────
  "advance-session": {
    command: "!advance",
    needsDriver: false,
    hasMessage: true,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Session Management",
    displayName: "Advance Session",
    mainLabel: "ADVANCE",
    subLabel: "SESSION",
  },
  "grid-set": {
    command: "!gridset",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: ["grid-set-section"],
    optgroup: "Session Management",
    displayName: "Delay Race Start",
    mainLabel: "DELAY",
    subLabel: "START",
  },
  "grid-start": {
    command: "!gridstart",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Session Management",
    displayName: "Start Race",
    mainLabel: "START",
    subLabel: "RACE",
  },
  "track-state": {
    command: "!trackstate",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: ["track-state-section"],
    optgroup: "Session Management",
    displayName: "Track State (Rubber)",
    mainLabel: "TRACK",
    subLabel: "STATE",
  },

  // ── Driver & Chat Management ──────────────────────────────────
  "grant-admin": {
    command: "!admin",
    needsDriver: true,
    hasMessage: true,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Driver & Chat Management",
    displayName: "Grant Admin",
    mainLabel: "GRANT",
    subLabel: "ADMIN",
  },
  "revoke-admin": {
    command: "!nadmin",
    needsDriver: true,
    hasMessage: true,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Driver & Chat Management",
    displayName: "Revoke Admin",
    mainLabel: "REVOKE",
    subLabel: "ADMIN",
  },
  "remove-driver": {
    command: "!remove",
    needsDriver: true,
    hasMessage: true,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Driver & Chat Management",
    displayName: "Remove Driver",
    mainLabel: "REMOVE",
    subLabel: "DRIVER",
  },
  "enable-chat-all": {
    command: "!chat",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Driver & Chat Management",
    displayName: "Enable Chat (All)",
    mainLabel: "CHAT",
    subLabel: "ENABLE",
  },
  "enable-chat-driver": {
    command: "!chat",
    needsDriver: true,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Driver & Chat Management",
    displayName: "Enable Chat (Driver)",
    mainLabel: "CHAT ON",
    subLabel: "DRIVER",
  },
  "disable-chat-all": {
    command: "!nchat",
    needsDriver: false,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Driver & Chat Management",
    displayName: "Disable Chat (All)",
    mainLabel: "CHAT",
    subLabel: "DISABLE",
  },
  "disable-chat-driver": {
    command: "!nchat",
    needsDriver: true,
    hasMessage: false,
    messageRequired: false,
    extraSettings: [],
    optgroup: "Driver & Chat Management",
    displayName: "Mute Driver",
    mainLabel: "MUTE",
    subLabel: "DRIVER",
  },
  "message-all": {
    command: "/all",
    needsDriver: false,
    hasMessage: true,
    messageRequired: true,
    extraSettings: [],
    optgroup: "Driver & Chat Management",
    displayName: "Message All Participants",
    mainLabel: "MSG",
    subLabel: "ALL",
  },
  "rc-message": {
    command: "/rc",
    needsDriver: false,
    hasMessage: true,
    messageRequired: true,
    extraSettings: [],
    optgroup: "Driver & Chat Management",
    displayName: "Race Control Message",
    mainLabel: "MSG",
    subLabel: "RC",
  },
};

/**
 * Group modes by optgroup for PI rendering.
 * @internal Exported for testing
 */
export function getModesByOptgroup(): Map<string, RaceAdminMode[]> {
  const groups = new Map<string, RaceAdminMode[]>();

  for (const mode of RACE_ADMIN_MODES) {
    const meta = RACE_ADMIN_MODE_META[mode];
    const list = groups.get(meta.optgroup) ?? [];
    list.push(mode);
    groups.set(meta.optgroup, list);
  }

  return groups;
}
