/**
 * `pnpm debug:plugin on|off|status` (#1338) — the local debug switch.
 *
 * The things that must never regress: the manifest is edited as text, so
 * `on` then `off` gives the file back byte for byte (never a parse-and-re-dump,
 * which re-expands the inline arrays); `on` twice is a no-op; a `Debug` value
 * the switch did not set is never overwritten or removed; and an edit that
 * would land anywhere but the one `Nodejs` block is refused rather than written.
 *
 * The file system is an in-memory double, so nothing here touches a manifest a
 * deck host may be running from.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  addDebugLine,
  DEBUG_VALUE,
  ELGATO_MANIFEST,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  manifestDebug,
  removeDebugLine,
  runDebugPlugin,
  USAGE,
} from "./debug-plugin.mjs";

const ROOT = path.resolve("/repo");
const FILE = path.join(ROOT, ELGATO_MANIFEST);

/** The shape of the real manifest around the block: inline-ish arrays, nested objects, the block mid-file. */
const OFF = [
  "{",
  '  "Actions": [',
  '    { "UUID": "a", "States": [{ "Image": "x" }], "Controllers": ["Keypad", "Encoder"] }',
  "  ],",
  '  "OS": [',
  "    {",
  '      "Platform": "windows",',
  '      "MinimumVersion": "10"',
  "    }",
  "  ],",
  '  "Nodejs": {',
  '    "Version": "24"',
  "  },",
  '  "ApplicationsToMonitor": { "windows": ["iRacingSim64DX11.exe"] },',
  '  "UUID": "com.iracedeck.sd.core"',
  "}",
  "",
].join("\n");

/** Exactly what the maintainer's hand edit looked like before the switch existed. */
const ON = OFF.replace('    "Version": "24"\n', `    "Version": "24",\n    "Debug": "${DEBUG_VALUE}"\n`);

function fakeLog() {
  return { log: vi.fn(), error: vi.fn() };
}

const output = (log) => [...log.log.mock.calls, ...log.error.mock.calls].map((args) => args.join(" ")).join("\n");

/** An in-memory file system holding the manifest; `writes` counts the writes. */
function fakeFs(contents) {
  const fs = {
    text: contents,
    writes: 0,
    readFileSync: (file) => {
      if (file !== FILE || fs.text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return fs.text;
    },
    writeFileSync: (file, data) => {
      expect(file).toBe(FILE);
      fs.writes++;
      fs.text = data;
    },
  };
  return fs;
}

const run = (verb, fs, log = fakeLog()) => ({ code: runDebugPlugin(verb, { root: ROOT, fs, log }), log });

describe("manifestDebug", () => {
  it("reports the three states", () => {
    expect(manifestDebug(OFF)).toEqual({ ok: true, present: false });
    expect(manifestDebug(ON)).toEqual({ ok: true, present: true, value: DEBUG_VALUE });
    expect(manifestDebug(ON.replace(DEBUG_VALUE, "enabled"))).toEqual({ ok: true, present: true, value: "enabled" });
  });

  it("counts presence, not value", () => {
    for (const value of ['""', "null", "false"])
      expect(manifestDebug(ON.replace(`"${DEBUG_VALUE}"`, value)).present).toBe(true);
  });

  it("only reads the Nodejs block", () => {
    expect(manifestDebug('{ "Debug": "x", "Nodejs": { "Version": "24" } }').present).toBe(false);
    expect(manifestDebug('{ "UUID": "x" }').present).toBe(false);
  });

  it("fails on text that is not a JSON object", () => {
    expect(manifestDebug("{ nope").ok).toBe(false);
    expect(manifestDebug("[]").ok).toBe(false);
  });
});

describe("the text edit", () => {
  it("adds exactly one line and takes exactly that line out again", () => {
    expect(addDebugLine(OFF)).toBe(ON);
    expect(removeDebugLine(ON)).toBe(OFF);
  });

  it("keeps CRLF line endings", () => {
    const crlf = OFF.replace(/\n/g, "\r\n");
    const on = addDebugLine(crlf);
    expect(on).toBe(ON.replace(/\n/g, "\r\n"));
    expect(removeDebugLine(on)).toBe(crlf);
  });

  it("handles a one-line block", () => {
    const one = '{\n  "Nodejs": { "Version": "24" },\n  "UUID": "x"\n}\n';
    const on = addDebugLine(one);
    expect(manifestDebug(on).value).toBe(DEBUG_VALUE);
    expect(removeDebugLine(on)).toBe(one);
  });

  it("removes a switch line placed before another property", () => {
    const first = OFF.replace('    "Version": "24"\n', `    "Debug": "${DEBUG_VALUE}",\n    "Version": "24"\n`);
    expect(removeDebugLine(first)).toBe(OFF);
  });

  it("refuses a manifest with no Nodejs block, or more than one", () => {
    expect(addDebugLine('{\n  "UUID": "x"\n}\n')).toBeNull();
    expect(addDebugLine(`${OFF}\n  "Nodejs": {\n    "Version": "20"\n  }\n`)).toBeNull();
    expect(removeDebugLine('{\n  "UUID": "x"\n}\n')).toBeNull();
  });

  it("refuses an empty block", () => expect(addDebugLine('{\n  "Nodejs": {\n  }\n}\n')).toBeNull());

  it("is not fooled by a brace inside a string in the block", () => {
    const braced = OFF.replace('"Version": "24"', '"Version": "2}4"');
    expect(removeDebugLine(addDebugLine(braced))).toBe(braced);
    expect(manifestDebug(addDebugLine(braced)).value).toBe(DEBUG_VALUE);
  });

  // The real file, whichever state this checkout's copy is in: a maintainer's
  // master may carry the switch's line locally, so the round trip starts from
  // whatever is on disk and must come back to it.
  it("round-trips the real Elgato manifest byte for byte", () => {
    const real = readFileSync(path.join(import.meta.dirname, "..", "..", ELGATO_MANIFEST), "utf-8");
    const state = manifestDebug(real);
    expect(state.ok).toBe(true);
    if (!state.present) {
      const on = addDebugLine(real);
      expect(manifestDebug(on).value).toBe(DEBUG_VALUE);
      expect(on.length - real.length).toBe(`,\n    "Debug": "${DEBUG_VALUE}"`.length + (real.includes("\r\n") ? 1 : 0));
      expect(removeDebugLine(on)).toBe(real);
    } else {
      expect(state.value).toBe(DEBUG_VALUE);
      expect(addDebugLine(removeDebugLine(real))).toBe(real);
    }
  });
});

describe("runDebugPlugin", () => {
  it("`on` then `off` restores the manifest byte for byte", () => {
    const fs = fakeFs(OFF);
    expect(run("on", fs).code).toBe(EXIT_OK);
    expect(fs.text).toBe(ON);
    expect(run("off", fs).code).toBe(EXIT_OK);
    expect(fs.text).toBe(OFF);
    expect(fs.writes).toBe(2);
  });

  it("`on` says the plugin must restart and that only developer mode reads the key", () => {
    const { log } = run("on", fakeFs(OFF));
    expect(output(log)).toMatch(/restart/i);
    expect(output(log)).toMatch(/developer mode/);
    expect(output(log)).toContain("pnpm debug:plugin off");
  });

  it("`off` says the plugin must restart", () => expect(output(run("off", fakeFs(ON)).log)).toMatch(/restart/i));

  it("`on` twice is a no-op", () => {
    const fs = fakeFs(OFF);
    run("on", fs);
    const second = run("on", fs);
    expect(second.code).toBe(EXIT_OK);
    expect(output(second.log)).toMatch(/already ON/);
    expect(fs.text).toBe(ON);
    expect(fs.writes).toBe(1);
  });

  it("`off` when off is a no-op", () => {
    const fs = fakeFs(OFF);
    const { code, log } = run("off", fs);
    expect(code).toBe(EXIT_OK);
    expect(output(log)).toMatch(/already OFF/);
    expect(fs.writes).toBe(0);
  });

  it("refuses to overwrite or remove a foreign Debug value, naming it", () => {
    const foreign = ON.replace(DEBUG_VALUE, "enabled");
    for (const verb of ["on", "off"]) {
      const fs = fakeFs(foreign);
      const { code, log } = run(verb, fs);
      expect(code).toBe(EXIT_REFUSED);
      expect(output(log)).toContain('"enabled"');
      expect(output(log)).toContain(ELGATO_MANIFEST);
      expect(fs.writes).toBe(0);
      expect(fs.text).toBe(foreign);
    }
  });

  it("`status` reports all three states and changes nothing", () => {
    const cases = [
      [OFF, /OFF/],
      [ON, /ON.*127\.0\.0\.1:9229/],
      [ON.replace(DEBUG_VALUE, "--inspect=0.0.0.0:1"), /did not set: "--inspect=0\.0\.0\.0:1"/],
    ];
    for (const [text, re] of cases) {
      const fs = fakeFs(text);
      const { code, log } = run("status", fs);
      expect(code).toBe(EXIT_OK);
      expect(output(log)).toMatch(re);
      expect(fs.writes).toBe(0);
    }
  });

  it("refuses a manifest it cannot read or parse", () => {
    expect(run("on", fakeFs(undefined)).code).toBe(EXIT_REFUSED);
    const fs = fakeFs("{ nope");
    expect(run("status", fs).code).toBe(EXIT_REFUSED);
    expect(run("on", fs).code).toBe(EXIT_REFUSED);
    expect(fs.writes).toBe(0);
  });

  it("refuses, writing nothing, a block it cannot edit as one line", () => {
    const fs = fakeFs('{\n  "UUID": "x"\n}\n');
    const { code, log } = run("on", fs);
    expect(code).toBe(EXIT_REFUSED);
    expect(output(log)).toMatch(/by hand/);
    expect(fs.writes).toBe(0);
  });

  it("reports usage for no verb or an unknown one", () => {
    for (const verb of [undefined, "enable", ""]) {
      const { code, log } = run(verb, fakeFs(OFF));
      expect(code).toBe(EXIT_USAGE);
      expect(output(log)).toContain(USAGE);
    }
  });
});
