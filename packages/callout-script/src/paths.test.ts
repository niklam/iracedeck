import { describe, expect, it } from "vitest";

import { CALLOUT_SCRIPT_FILE, calloutScriptPath } from "./paths.js";

describe("calloutScriptPath", () => {
  it("places the script inside the voice's own tree, POSIX-separated", () => {
    expect(calloutScriptPath("default")).toBe("voice/default/callouts.json");
    expect(calloutScriptPath("aaa-test")).toBe("voice/aaa-test/callouts.json");
  });

  it("uses the exported file name, so the two cannot drift", () => {
    expect(calloutScriptPath("x")).toBe(`voice/x/${CALLOUT_SCRIPT_FILE}`);
    expect(CALLOUT_SCRIPT_FILE).toBe("callouts.json");
  });
});
