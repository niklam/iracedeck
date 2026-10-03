import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { emptyVoicePackStatus, VOICE_PACK_INSTALL_PHASES, VOICE_PACK_OFFER_VERDICTS } from "./voice-pack-status.js";

describe("emptyVoicePackStatus", () => {
  it("starts a run knowing nothing and doing nothing", () => {
    expect(emptyVoicePackStatus()).toEqual({ catalog: { state: "unknown" }, installs: {} });
  });

  it("is a fresh object each call, so one run's status cannot leak into another", () => {
    const first = emptyVoicePackStatus();

    first.installs.luca = { phase: "downloading" };

    expect(emptyVoicePackStatus().installs).toEqual({});
  });
});

describe("phase and verdict vocabularies", () => {
  // A succeeded install is not a phase: the pack moves to `_voicePacks`, and a
  // terminal "done" here would be a second key claiming to say what is
  // installed. `failed` stays because nothing else records it.
  it("has no success phase", () => {
    expect(VOICE_PACK_INSTALL_PHASES).not.toContain("done");
    expect(VOICE_PACK_INSTALL_PHASES).toContain("failed");
  });

  it("can express a pack that is listed but not installable", () => {
    expect(VOICE_PACK_OFFER_VERDICTS).toContain("unsupported");
  });

  it("matches the settings card's copy of the phase list, which has no verifying (#1102)", () => {
    // The card is bundled into the settings window and imports nothing from
    // deck-core, so it restates the list; a phase the card does not know is
    // dropped as unrecognised, which is how a stale copy would fail silently.
    const card = readFileSync(
      new URL("../../pi-components/src/components/voice-pack-catalog.ts", import.meta.url),
      "utf8",
    );
    const literal = /const KNOWN_PHASES = \[([^\]]*)\] as const;/.exec(card)?.[1];

    expect(literal).toBeDefined();

    const cardPhases = [...(literal ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);

    expect(cardPhases).toEqual([...VOICE_PACK_INSTALL_PHASES]);
    expect(VOICE_PACK_INSTALL_PHASES).not.toContain("verifying");
  });
});
