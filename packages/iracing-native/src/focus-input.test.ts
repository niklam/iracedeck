/**
 * What the native focuser sends before `SetForegroundWindow` (#1738).
 *
 * The suite runs against the mock (#1084), so the real addon's input cannot be
 * observed from Vitest; the sim test in the #1738 spec is its behavioural test.
 * This guards the source instead: the focuser must satisfy Windows' foreground
 * lock with a zero-distance mouse move and send no key, because a key tapped
 * through the attached input lands in the window that was in front, and a lone
 * Alt there leaves that window in menu mode.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ADDON_SOURCE = readFileSync(new URL("./addon.cc", import.meta.url), "utf8");

/** The body of `static int focusIRacingWindow()`, up to its closing brace at column 0. */
function focuserBody(): string {
  const start = ADDON_SOURCE.indexOf("static int focusIRacingWindow()");
  expect(start, "focusIRacingWindow() not found in addon.cc").toBeGreaterThanOrEqual(0);

  const end = ADDON_SOURCE.indexOf("\n}\n", start);
  expect(end, "end of focusIRacingWindow() not found").toBeGreaterThan(start);

  return ADDON_SOURCE.slice(start, end);
}

describe("focusIRacingWindow's foreground-lock input (#1738)", () => {
  it("sends a zero-distance relative mouse move", () => {
    const body = focuserBody();

    expect(body).toContain("INPUT_MOUSE");
    expect(body).toMatch(/\.mi\.dwFlags\s*=\s*MOUSEEVENTF_MOVE;/);
    expect(body).toMatch(/\.mi\.dx\s*=\s*0;/);
    expect(body).toMatch(/\.mi\.dy\s*=\s*0;/);
    expect(body).toContain("SendInput(1,");
  });

  it("sends no key, Alt or otherwise", () => {
    const code = focuserBody()
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    expect(code).not.toMatch(/keybd_event|INPUT_KEYBOARD|VK_MENU|makeScanKeyInput|sendScanKey/);
  });
});
