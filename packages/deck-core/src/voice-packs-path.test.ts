import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveVoicePacksPath } from "./voice-packs-path.js";

/**
 * Separators are normalised before comparing, exactly as `settings-store.test.ts`
 * does for the sibling resolver: `join` emits `\` on Windows and `/` on POSIX,
 * and CI runs the test job on `ubuntu-latest`. A backslash literal is green on
 * the author's machine and red on the only machine that gates the merge.
 *
 * The override cases below compare raw, because an override is returned verbatim
 * and never goes through `join` — there is nothing platform-dependent to hide.
 */
const norm = (value: string): string => value.replace(/\\/g, "/");

describe("resolveVoicePacksPath", () => {
  it("uses LOCALAPPDATA", () => {
    const resolved = resolveVoicePacksPath({ env: { LOCALAPPDATA: "C:\\Users\\n\\AppData\\Local" } });

    expect(norm(resolved)).toBe("C:/Users/n/AppData/Local/iRaceDeck/Race Engineer/Voices");
  });

  it("honours the IRACEDECK_VOICE_PACKS_PATH override", () => {
    expect(resolveVoicePacksPath({ env: { LOCALAPPDATA: "C:\\x", IRACEDECK_VOICE_PACKS_PATH: "D:\\packs" } })).toBe(
      "D:\\packs",
    );
  });

  it("treats a blank LOCALAPPDATA as unset and still returns an absolute path", () => {
    const resolved = resolveVoicePacksPath({ env: { LOCALAPPDATA: "   ", USERPROFILE: "C:\\Users\\n" } });

    expect(norm(resolved)).toBe("C:/Users/n/AppData/Local/iRaceDeck/Race Engineer/Voices");
  });

  it("treats a blank override as unset", () => {
    const resolved = resolveVoicePacksPath({ env: { LOCALAPPDATA: "C:\\x", IRACEDECK_VOICE_PACKS_PATH: "  " } });

    expect(norm(resolved)).toBe("C:/x/iRaceDeck/Race Engineer/Voices");
  });

  it("stays absolute with BOTH LOCALAPPDATA and USERPROFILE missing — the OS home directory is the last resort", () => {
    // The one line that stops the packs root becoming a RELATIVE path resolved
    // against the deck host's working directory. Nothing exercised it before.
    const resolved = resolveVoicePacksPath({ env: {} });

    expect(isAbsolute(resolved)).toBe(true);
    expect(norm(resolved)).toBe(`${norm(homedir())}/AppData/Local/iRaceDeck/Race Engineer/Voices`);
  });

  it("has no ecosystem segment — packs are shared across plugins", () => {
    const resolved = resolveVoicePacksPath({ env: { LOCALAPPDATA: "C:\\x" } });

    expect(resolved).not.toMatch(/Stream Deck|Mirabox|Ulanzi/);
  });
});
