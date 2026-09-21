import { describe, expect, it } from "vitest";

import { qualifiedVoiceId, qualifyClipPath, qualifyVoiceId, splitVoiceId, VOICE_ID_SEPARATOR } from "./voice-id.js";

describe("VOICE_ID_SEPARATOR", () => {
  it("is two characters, so a single colon stays free for the id grammar", () => {
    expect(VOICE_ID_SEPARATOR).toBe("::");
  });
});

describe("qualifiedVoiceId", () => {
  it("joins a pack id and a voice id with the separator", () => {
    expect(qualifiedVoiceId("default", "default")).toBe("default::default");
    expect(qualifiedVoiceId("luca", "matt")).toBe("luca::matt");
  });
});

describe("splitVoiceId", () => {
  it("splits a composite id into its halves", () => {
    expect(splitVoiceId("luca::matt")).toEqual({ packId: "luca", voiceId: "matt" });
  });

  it("returns null for a bare id", () => {
    expect(splitVoiceId("matt")).toBeNull();
    expect(splitVoiceId("")).toBeNull();
  });

  it.each([
    ["an empty pack half", "::b"],
    ["an empty voice half", "a::"],
    ["two separators", "a::b::c"],
    ["a bare separator", "::"],
  ])("returns null for %s", (_label, id) => {
    expect(splitVoiceId(id)).toBeNull();
  });
});

describe("qualifyClipPath", () => {
  it("rewrites the voice segment of a voice clip", () => {
    expect(qualifyClipPath("luca", "voice/matt/flags/green.mp3")).toBe("voice/luca::matt/flags/green.mp3");
  });

  it("keeps the whole tail, however deep", () => {
    expect(qualifyClipPath("luca", "voice/matt/callouts.json")).toBe("voice/luca::matt/callouts.json");
  });

  it("leaves a clip outside voice/ alone", () => {
    expect(qualifyClipPath("luca", "sfx/tick.mp3")).toBe("sfx/tick.mp3");
  });

  it("leaves a path with no segment after the voice alone", () => {
    // `voice/matt` names the folder, not a file inside it; nothing to rewrite.
    expect(qualifyClipPath("luca", "voice/matt")).toBe("voice/matt");
    expect(qualifyClipPath("luca", "voice/matt/")).toBe("voice/matt/");
  });

  it("leaves a bare voice/ prefix with nothing after it alone", () => {
    expect(qualifyClipPath("luca", "voice/")).toBe("voice/");
    expect(qualifyClipPath("luca", "voice")).toBe("voice");
  });
});

describe("qualifyVoiceId", () => {
  const MANAGED = "default";

  it("returns an empty value unchanged", () => {
    expect(qualifyVoiceId("", ["default::default"], MANAGED)).toBe("");
  });

  it("returns a composite value unchanged, even when it is not available", () => {
    // Never rewrite a choice that already names its pack: the pack may
    // simply not have arrived yet.
    expect(qualifyVoiceId("x::y", ["default::default"], MANAGED)).toBe("x::y");
    expect(qualifyVoiceId("default::default", [], MANAGED)).toBe("default::default");
  });

  it("returns a bare id unchanged when it is itself an available voice, ahead of any pack providing it", () => {
    // A bare id in the list is a real voice — the harness's source-tree voice,
    // or one a plugin bundles — not a pre-#1144 value to reinterpret.
    expect(qualifyVoiceId("default", ["default", "default::default"], MANAGED)).toBe("default");
    expect(qualifyVoiceId("matt", ["a-pack::matt", "matt"], MANAGED)).toBe("matt");
  });

  it("qualifies a bare id with the managed pack when that pack provides it", () => {
    expect(qualifyVoiceId("default", ["a-pack::default", "default::default"], MANAGED)).toBe("default::default");
    expect(qualifyVoiceId("matt", ["b-pack::matt", "default::matt"], MANAGED)).toBe("default::matt");
  });

  it("otherwise qualifies with the alphabetically first pack that provides it", () => {
    expect(qualifyVoiceId("matt", ["b-pack::matt", "a-pack::matt"], MANAGED)).toBe("a-pack::matt");
  });

  it("orders by PACK id, not by the composite string", () => {
    // `a-b::v` < `a::v` as strings (`-` sorts before `:`), but `a` < `a-b` as
    // pack ids — the order that decided who claimed a voice before #1144.
    expect(qualifyVoiceId("v", ["a-b::v", "a::v"], MANAGED)).toBe("a::v");
  });

  it("ignores available entries for other voices", () => {
    expect(qualifyVoiceId("matt", ["a-pack::nina", "b-pack::matt"], MANAGED)).toBe("b-pack::matt");
  });

  it("returns a bare id unchanged when no pack provides it", () => {
    expect(qualifyVoiceId("ghost", ["default::default", "a-pack::matt"], MANAGED)).toBe("ghost");
    expect(qualifyVoiceId("ghost", [], MANAGED)).toBe("ghost");
  });

  it("skips a malformed available entry rather than matching it", () => {
    expect(qualifyVoiceId("matt", ["::matt", "a::matt::b", "b-pack::matt"], MANAGED)).toBe("b-pack::matt");
  });
});
