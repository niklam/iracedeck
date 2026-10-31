/**
 * Keyboard Service Singleton
 *
 * Provides a lazy-initialized singleton for sending keyboard inputs.
 * Keys are sent one way only: as PS/2 scan codes through SendInput
 * (KEYEVENTF_SCANCODE) via iracing-native, so the same binding presses the
 * same physical key whatever the keyboard layout. A combination is sent when
 * the matching scan-code sender was injected and the combination carries an
 * event.code the scan-code map can build; otherwise nothing is sent and the
 * call returns false (#1495). There is no string-based fallback: a binding
 * without a scan code is one the binding dispatcher already reads as unbound.
 *
 * This is also where the iRacing window is focused before a keystroke (#977):
 * every deck-core keystroke passes this layer, so `focusIRacingBeforeInput()`
 * runs here, immediately before each native send — once per emitted keystroke,
 * after every path that would send nothing has returned (a missing sender, a
 * combination with no scan code, an empty or unmappable sequence). Placing it
 * here rather than in the binding dispatcher covers the direct `getKeyboard()`
 * callers too, without them knowing it: Race Admin's Ctrl+V paste into the chat
 * prompt and Car Control's Escape press reach the sim through the same methods
 * a binding does. Releases never focus — a keyup must not pull the window
 * forward, and `SendInput` keyups update the global key state whatever is in
 * front.
 *
 * The same layer follows every Ctrl+Alt chord it completes (a tap, the release
 * of a held combination, a sequence containing one) with an Alt+F24 tap
 * (#1508): iRacing's text input can lock after a Ctrl+Alt chord until some
 * Alt+key arrives, and while it is locked every chat macro fails silently.
 *
 * Usage:
 * 1. Call initializeKeyboard() once at plugin startup
 * 2. Use getKeyboard() in your actions to send key combinations
 *
 * @example
 * // At startup (the shared bootstrap: plugin-runtime's phases/input.ts)
 * import { initializeKeyboard } from "@iracedeck/deck-core";
 * import { IRacingNative } from "@iracedeck/iracing-native";
 *
 * const native = new IRacingNative();
 * initializeKeyboard(logger, (scanCodes) => native.sendScanKeys(scanCodes));
 *
 * // In action files
 * import { getKeyboard } from "@iracedeck/deck-core";
 *
 * const keyboard = getKeyboard();
 * await keyboard.sendKeyCombination({ key: "f3", code: "F3" });
 * await keyboard.sendKeyCombination({ key: "r", code: "KeyR", modifiers: ["shift"] });
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import type { KeyCombination } from "./keyboard-types.js";
import { getModifierScanCode, getScanCode } from "./scan-code-map.js";
import { focusIRacingBeforeInput } from "./window-focus-service.js";

/**
 * Function type for sending scan codes via native SendInput (tap: press + release).
 * Takes an array of PS/2 scan codes (modifiers first, then main key).
 * The implementation presses each in order, then releases in reverse.
 */
export type ScanKeySender = (scanCodes: number[]) => void;

/**
 * Function type for pressing scan codes without releasing (key hold).
 * Takes an array of PS/2 scan codes (modifiers first, then main key).
 * Caller must call the corresponding releaser to release keys.
 */
export type ScanKeyPresser = (scanCodes: number[]) => void;

/**
 * Function type for releasing scan codes without pressing (key release).
 * Takes an array of PS/2 scan codes (modifiers first, then main key).
 * Releases in reverse order. Should follow a prior press call.
 */
export type ScanKeyReleaser = (scanCodes: number[]) => void;

/**
 * Function type for sending a SEQUENCE of distinct scan code chords in one
 * native call (issue #818). Each chord is an array of PS/2 scan codes
 * (modifiers first, then main key); chords fire in order.
 *
 * `holdMs === 0` emits the whole sequence in one atomic SendInput batch with no
 * sleep, so the target consumes every event in the same frame.
 */
export type ScanKeySequenceSender = (chords: number[][], holdMs: number) => void;

/**
 * Interface for the keyboard service.
 *
 * Every method sends by scan code only. Each returns false, having sent
 * nothing and focused nothing, when its sender was not injected or a
 * combination has no event.code the scan-code map can build (#1495).
 */
export interface IKeyboardService {
  /**
   * Send a key combination (key with optional modifiers). Tap behavior: press then release.
   * @param combination - The key combination to send
   * @returns true if sent, false if nothing could be sent or an error occurred
   */
  sendKeyCombination(combination: KeyCombination): Promise<boolean>;

  /**
   * Press a key combination and hold it down (no release).
   * Caller must call {@link releaseKeyCombination} to release the keys.
   * @param combination - The key combination to press
   * @returns true if pressed, false if nothing could be pressed or an error occurred
   */
  pressKeyCombination(combination: KeyCombination): Promise<boolean>;

  /**
   * Release a previously held key combination.
   * Should be called after {@link pressKeyCombination} to release held keys.
   * @param combination - The key combination to release
   * @returns true if released, false if nothing could be released or an error occurred
   */
  releaseKeyCombination(combination: KeyCombination): Promise<boolean>;

  /**
   * Send a sequence of distinct key combinations in one native call.
   *
   * The sequence is atomic or skipped: a sequence sent chord by chord defeats
   * the purpose — the caller uses this precisely to avoid an intermediate state
   * being rendered (issue #818). Returns false when the sequence sender was not
   * supplied, the sequence is empty, or any combination lacks a scan code
   * mapping. Callers must treat false as "skipped", never as "send it the slow
   * way".
   *
   * @param combinations - The chords to send, in order
   * @param holdMs - Per-chord hold in ms; 0 (default) = one atomic batch, no sleep.
   *   A non-zero value takes the native held path, which sleeps on the CALLING
   *   thread once per chord — it is clamped natively to 50 ms (a few frames), so a
   *   two-chord sequence blocks at most ~100 ms, matching an ordinary tap. Only
   *   raise it for a target that samples keyboard state per frame and drops a
   *   zero-duration press; iRacing does not.
   * @returns true if the sequence was dispatched, false if it was skipped
   */
  sendKeySequence(combinations: KeyCombination[], holdMs?: number): Promise<boolean>;
}

/**
 * The tap iRaceDeck sends after every Ctrl+Alt chord (#1508). iRacing's text
 * input can lock after a Ctrl+Alt chord until some Alt+key arrives, and while
 * it is locked every chat macro fails silently. This is that Alt+key: left Alt
 * and F24, a key no ordinary keyboard has, so the chord does nothing else in
 * iRacing or Windows.
 */
const F24_SCAN_CODE = 0x76;
const CTRL_ALT_LOCK_RELEASE_SCAN_CODES: readonly number[] = [getModifierScanCode("alt")!, F24_SCAN_CODE];

/**
 * Whether a combination is a Ctrl+Alt chord: its modifiers include both Ctrl
 * and Alt, whatever else they hold.
 */
function isCtrlAltChord(combination: KeyCombination): boolean {
  const modifiers = combination.modifiers ?? [];

  return modifiers.includes("ctrl") && modifiers.includes("alt");
}

/** Render scan codes for a debug line, e.g. `[0x1d, 0x26]`. */
function formatScanCodes(scanCodes: number[]): string {
  return `[${scanCodes.map((sc) => `0x${sc.toString(16)}`).join(", ")}]`;
}

/**
 * Keyboard service implementation. Sends by scan code only.
 */
class KeyboardService implements IKeyboardService {
  private logger: ILogger;
  private scanKeySender: ScanKeySender | null;
  private scanKeyPresser: ScanKeyPresser | null;
  private scanKeyReleaser: ScanKeyReleaser | null;
  private scanKeySequenceSender: ScanKeySequenceSender | null;

  constructor(
    logger: ILogger,
    scanKeySender: ScanKeySender | null,
    scanKeyPresser: ScanKeyPresser | null,
    scanKeyReleaser: ScanKeyReleaser | null,
    scanKeySequenceSender: ScanKeySequenceSender | null,
  ) {
    this.logger = logger;
    this.scanKeySender = scanKeySender;
    this.scanKeyPresser = scanKeyPresser;
    this.scanKeyReleaser = scanKeyReleaser;
    this.scanKeySequenceSender = scanKeySequenceSender;
  }

  /**
   * Tap a key combination: press then release, by scan code. Sends nothing
   * and returns false without a scan-code sender or a buildable combination.
   */
  async sendKeyCombination(combination: KeyCombination): Promise<boolean> {
    const sender = this.scanKeySender;

    if (!sender) {
      this.logger.debug("No scan key sender configured, skipping key combination");

      return false;
    }

    const scanCodes = this.buildScanCodes(combination);

    if (!scanCodes) {
      return false;
    }

    try {
      this.logger.debug(
        `Sending scan codes: ${formatScanCodes(scanCodes)} (code="${combination.code}", key="${combination.key}")`,
      );

      focusIRacingBeforeInput();
      sender(scanCodes);
      await this.releaseCtrlAltLock(combination);

      return true;
    } catch (error) {
      this.logger.error(`Failed to send scan codes: ${JSON.stringify(combination)}: ${error}`);

      return false;
    }
  }

  /**
   * Press a key combination without releasing it (key hold), by scan code.
   * Sends nothing and returns false without a scan-code presser or a
   * buildable combination.
   */
  async pressKeyCombination(combination: KeyCombination): Promise<boolean> {
    const presser = this.scanKeyPresser;

    if (!presser) {
      this.logger.debug("No scan key presser configured, skipping key press");

      return false;
    }

    const scanCodes = this.buildScanCodes(combination);

    if (!scanCodes) {
      return false;
    }

    try {
      this.logger.debug(
        `Pressing scan codes: ${formatScanCodes(scanCodes)} (code="${combination.code}", key="${combination.key}")`,
      );

      focusIRacingBeforeInput();
      presser(scanCodes);

      return true;
    } catch (error) {
      this.logger.error(`Failed to press scan codes: ${JSON.stringify(combination)}: ${error}`);

      return false;
    }
  }

  /**
   * Release a held key combination without pressing it, by scan code. Sends
   * nothing and returns false without a scan-code releaser or a buildable
   * combination. A held Ctrl+Alt chord is complete only once it is released,
   * so the Alt+F24 follow-up (#1508) goes out here, not on the press.
   */
  async releaseKeyCombination(combination: KeyCombination): Promise<boolean> {
    const releaser = this.scanKeyReleaser;

    if (!releaser) {
      this.logger.debug("No scan key releaser configured, skipping key release");

      return false;
    }

    const scanCodes = this.buildScanCodes(combination);

    if (!scanCodes) {
      return false;
    }

    try {
      this.logger.debug(
        `Releasing scan codes: ${formatScanCodes(scanCodes)} (code="${combination.code}", key="${combination.key}")`,
      );

      // No focus on a release (#977): a keyup must never pull the window forward.
      releaser(scanCodes);
      await this.releaseCtrlAltLock(combination);

      return true;
    } catch (error) {
      this.logger.error(`Failed to release scan codes: ${JSON.stringify(combination)}: ${error}`);

      return false;
    }
  }

  async sendKeySequence(combinations: KeyCombination[], holdMs = 0): Promise<boolean> {
    if (!this.scanKeySequenceSender) {
      this.logger.debug("No scan key sequence sender configured, skipping sequence");

      return false;
    }

    if (combinations.length === 0) {
      return false;
    }

    const chords: number[][] = [];

    for (const combination of combinations) {
      // Atomic or not at all: one chord that cannot be built skips the sequence.
      const scanCodes = this.buildScanCodes(combination);

      if (!scanCodes) {
        this.logger.debug("Skipping key sequence");

        return false;
      }

      chords.push(scanCodes);
    }

    try {
      const rendered = chords.map(formatScanCodes).join(" -> ");
      this.logger.debug(`Sending scan code sequence: ${rendered} (holdMs=${holdMs})`);

      // After the loop above, so a sequence that is skipped never focuses.
      focusIRacingBeforeInput();
      this.scanKeySequenceSender(chords, holdMs);

      // One follow-up for the whole sequence: an Alt+key after its last
      // Ctrl+Alt chord releases a lock any of them caused (#1508).
      const ctrlAltChord = combinations.find(isCtrlAltChord);

      if (ctrlAltChord) {
        void this.releaseCtrlAltLock(ctrlAltChord);
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to send scan code sequence: ${error}`);

      return false;
    }
  }

  /**
   * Follow a Ctrl+Alt chord with the Alt+F24 tap that releases iRacing's text
   * input lock (#1508); a no-op for any other combination, and when no
   * scan-code sender is configured. Sent as an ordinary scan-code tap (the
   * 100 ms shape verified in iRacing), which runs before this returns its
   * promise, so it follows the chord in order even when the caller does not
   * await it. Never focuses (the chord already did) and never throws: a
   * failure here must not change the result of the chord it follows.
   */
  private async releaseCtrlAltLock(combination: KeyCombination): Promise<void> {
    if (!isCtrlAltChord(combination) || !this.scanKeySender) {
      return;
    }

    try {
      this.logger.debug("Sending Alt+F24 after a Ctrl+Alt chord");
      this.scanKeySender([...CTRL_ALT_LOCK_RELEASE_SCAN_CODES]);
    } catch (error) {
      this.logger.warn(`Failed to send Alt+F24 after a Ctrl+Alt chord: ${error}`);
    }
  }

  /**
   * Build the scan codes of a key combination: modifiers first, then the main
   * key. Returns null, having logged why, when the combination has no
   * event.code (an empty string counts as none) or a modifier or the code has
   * no scan code; the caller then sends nothing (#1495).
   */
  private buildScanCodes(combination: KeyCombination): number[] | null {
    if (!combination.code) {
      this.logger.warn("Key combination has no scan code, nothing sent; re-record the binding");
      this.logger.debug(`Key combination without event.code: ${JSON.stringify(combination)}`);

      return null;
    }

    const scanCodes: number[] = [];

    if (combination.modifiers) {
      for (const modifier of combination.modifiers) {
        const sc = getModifierScanCode(modifier);

        if (sc === undefined) {
          this.logger.warn("Unknown modifier in key combination, nothing sent");
          this.logger.debug(`Unknown modifier "${modifier}" in ${JSON.stringify(combination)}`);

          return null;
        }

        scanCodes.push(sc);
      }
    }

    const mainSc = getScanCode(combination.code);

    if (mainSc === undefined) {
      this.logger.warn("No scan code for the key combination, nothing sent");
      this.logger.debug(`No scan code for event.code="${combination.code}" (key="${combination.key}")`);

      return null;
    }

    scanCodes.push(mainSc);

    return scanCodes;
  }
}

// Singleton instance
let keyboardService: KeyboardService | null = null;

/**
 * Initialize the keyboard service singleton.
 * Should be called once at plugin startup.
 *
 * @param logger - Optional logger instance for keyboard service logging
 * @param scanKeySender - Optional function for tap-sending PS/2 scan codes (press + release).
 *   Without it, `sendKeyCombination` sends nothing and returns false, and no Alt+F24
 *   follow-up (#1508) is sent after any Ctrl+Alt chord.
 * @param scanKeyPresser - Optional function for pressing PS/2 scan codes without releasing (for key hold).
 *   Without it, `pressKeyCombination` sends nothing and returns false.
 * @param scanKeyReleaser - Optional function for releasing PS/2 scan codes without pressing (for key release).
 *   Without it, `releaseKeyCombination` sends nothing and returns false.
 * @param scanKeySequenceSender - Optional function for sending a sequence of distinct scan code chords in one
 *   atomic native call (issue #818). When omitted, `sendKeySequence` always returns false (skipped).
 * @returns The initialized keyboard service
 * @throws Error if called more than once
 */
export function initializeKeyboard(
  logger: ILogger = silentLogger,
  scanKeySender?: ScanKeySender,
  scanKeyPresser?: ScanKeyPresser,
  scanKeyReleaser?: ScanKeyReleaser,
  scanKeySequenceSender?: ScanKeySequenceSender,
): IKeyboardService {
  if (keyboardService) {
    throw new Error("Keyboard service already initialized. initializeKeyboard() should only be called once.");
  }

  keyboardService = new KeyboardService(
    logger,
    scanKeySender ?? null,
    scanKeyPresser ?? null,
    scanKeyReleaser ?? null,
    scanKeySequenceSender ?? null,
  );

  return keyboardService;
}

/**
 * Get the keyboard service for sending key combinations.
 *
 * @returns The keyboard service instance
 * @throws Error if keyboard service hasn't been initialized
 */
export function getKeyboard(): IKeyboardService {
  if (!keyboardService) {
    throw new Error("Keyboard service not initialized. Call initializeKeyboard() first in your plugin entry point.");
  }

  return keyboardService;
}

/**
 * Check if the keyboard service has been initialized.
 *
 * @returns true if keyboard service is initialized, false otherwise
 */
export function isKeyboardInitialized(): boolean {
  return keyboardService !== null;
}

/**
 * Reset the keyboard service singleton (for testing purposes only).
 * @internal
 */
export function _resetKeyboard(): void {
  keyboardService = null;
}
