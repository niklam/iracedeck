/// <reference lib="dom" />
/**
 * Capture CPU profile, on the settings window's Diagnostics tab (#1338).
 *
 * Three elements, because they are three jobs:
 *
 * - `ird-capture-cpu-profile` — the button. Sends
 *   `sendToPlugin { event: "captureCpuProfile" }` and nothing else: no
 *   duration, no path. The plugin owns both (`settings-window.md`: a command
 *   never takes a path from the page). A press during a capture is refused by
 *   the plugin, whose state this page already shows as capturing.
 * - `ird-open-profiles-folder` — opens the plugin's own profiles folder
 *   (`openProfilesFolder`).
 * - `ird-cpu-profile-status` — renders the run-scoped `_profileCaptureStatus`:
 *   a countdown while capturing, the saved file's name, or why it failed.
 *   Nothing while idle.
 *
 * Both buttons are `defineSendToPluginButton` instances, the one design for a
 * one-shot `sendToPlugin` button. Every cell the status writes is
 * `textContent`: the reason is an error message from the plugin's filesystem.
 *
 * Usage (settings window only — a PI's `sendToPlugin` goes to its action):
 * ```html
 * <ird-capture-cpu-profile></ird-capture-cpu-profile>
 * <ird-open-profiles-folder></ird-open-profiles-folder>
 * <ird-cpu-profile-status></ird-cpu-profile-status>
 * ```
 */
import { PROFILE_CAPTURE_STATUS_KEY } from "@iracedeck/app-constants";

import { defineSendToPluginButton } from "./send-to-plugin-button.js";
import { skipUnchanged } from "./settings-change-filter.js";

export const CaptureCpuProfile = defineSendToPluginButton({
  tag: "ird-capture-cpu-profile",
  defaultLabel: "Capture CPU profile",
  payload: { event: "captureCpuProfile" },
  defaultSize: "compact",
});

export const OpenProfilesFolder = defineSendToPluginButton({
  tag: "ird-open-profiles-folder",
  defaultLabel: "Open folder",
  payload: { event: "openProfilesFolder" },
  defaultSize: "compact",
});

/** The browser's reading of deck-core's `ProfileCaptureStatus`; anything unreadable is idle. */
type CaptureStatus =
  | { state: "idle" }
  | { state: "capturing"; startedAt: number; durationMs: number }
  | { state: "saved"; file: string }
  | { state: "failed"; reason: string };

const IDLE: CaptureStatus = { state: "idle" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @internal Exported for testing */
export function parseCaptureStatus(raw: unknown): CaptureStatus {
  if (typeof raw !== "string" || raw === "") return IDLE;

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return IDLE;
  }

  if (!isRecord(parsed)) return IDLE;

  switch (parsed.state) {
    case "capturing":
      return typeof parsed.startedAt === "number" && typeof parsed.durationMs === "number"
        ? { state: "capturing", startedAt: parsed.startedAt, durationMs: parsed.durationMs }
        : IDLE;
    case "saved":
      return typeof parsed.file === "string" ? { state: "saved", file: parsed.file } : IDLE;
    case "failed":
      return { state: "failed", reason: typeof parsed.reason === "string" ? parsed.reason : "unknown reason" };
    default:
      return IDLE;
  }
}

/** What the status line says at `now` (epoch ms). Empty while idle. */
export function describeCaptureStatus(status: CaptureStatus, now: number): string {
  switch (status.state) {
    case "capturing": {
      const left = Math.ceil((status.startedAt + status.durationMs - now) / 1000);

      return left > 0 ? `Capturing… ${left} s left` : "Capturing… saving the profile";
    }

    case "saved":
      return `Saved ${status.file}`;
    case "failed":
      return `Capture failed: ${status.reason}`;
    default:
      return "";
  }
}

export class CpuProfileStatus extends HTMLElement {
  private initialized = false;
  private status: CaptureStatus = IDLE;
  private timer: ReturnType<typeof setInterval> | undefined;

  connectedCallback(): void {
    // A re-attach (the element moved, or a tab re-rendered it) keeps its
    // subscription but lost its countdown in `disconnectedCallback`, so it
    // re-renders, which restarts the countdown when a capture is running.
    if (this.initialized) {
      this.render();

      return;
    }

    this.initialized = true;
    this.className = "ird-supporting-text";
    this.render();
    this.hookSettings();
  }

  disconnectedCallback(): void {
    this.stopCountdown();
  }

  /**
   * Subscribe to capture status changes, updating the message and countdown.
   * Does nothing when SDPIComponents is unavailable.
   */
  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    window.SDPIComponents.useGlobalSettings(
      PROFILE_CAPTURE_STATUS_KEY,
      skipUnchanged((value: string) => {
        this.status = parseCaptureStatus(value);
        this.render();
      }),
    );
  }

  private stopCountdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);

    this.timer = undefined;
  }

  private render(): void {
    const text = describeCaptureStatus(this.status, Date.now());

    this.textContent = text;
    this.hidden = text === "";
    this.dataset.state = this.status.state;

    if (this.status.state === "capturing") {
      if (this.timer === undefined) this.timer = setInterval(() => this.render(), 1000);
    } else {
      this.stopCountdown();
    }
  }
}

if (!customElements.get("ird-cpu-profile-status")) customElements.define("ird-cpu-profile-status", CpuProfileStatus);
