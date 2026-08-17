import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PI_SETTINGS_BRIDGE } from "./index.mjs";
import { assertBridgeInjectionPlugin, injectBridgeScriptPlugin } from "./inject-bridge-plugin.mjs";

const SDPI = '<script src="sdpi-components.js"></script>';

describe("injectBridgeScriptPlugin", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ird-inject-bridge-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, html: string): string {
    const p = path.join(dir, name);

    writeFileSync(p, html, "utf-8");

    return p;
  }

  function run(opts: Parameters<typeof injectBridgeScriptPlugin>[0]): void {
    const plugin = injectBridgeScriptPlugin(opts);

    (plugin.writeBundle as () => void).call({});
  }

  it("injects the bridge tag immediately before sdpi-components.js in matching files", () => {
    const p = write("car-control.html", `<head>${SDPI}</head>`);

    run({ outputDir: dir, bridge: "ulanzi-pi-bridge.js", include: () => true });

    expect(readFileSync(p, "utf-8")).toBe(`<head><script src="ulanzi-pi-bridge.js"></script>\n    ${SDPI}</head>`);
  });

  it("leaves files the include predicate rejects untouched", () => {
    const pi = write("car-control.html", `<head>${SDPI}</head>`);
    const sw = write("settings-window.html", `<head>${SDPI}</head>`);

    run({ outputDir: dir, bridge: "ulanzi-pi-bridge.js", include: (f) => f !== "settings-window.html" });

    expect(readFileSync(pi, "utf-8")).toContain("ulanzi-pi-bridge.js");
    expect(readFileSync(sw, "utf-8")).not.toContain("ulanzi-pi-bridge.js");
  });

  it("is idempotent — a second run does not inject twice", () => {
    const p = write("a.html", `<head>${SDPI}</head>`);

    run({ outputDir: dir, bridge: "x-bridge.js", include: () => true });
    run({ outputDir: dir, bridge: "x-bridge.js", include: () => true });

    expect(readFileSync(p, "utf-8").match(/x-bridge\.js/g)).toHaveLength(1);
  });

  it("skips files with no sdpi-components tag", () => {
    const p = write("plain.html", "<head></head>");

    run({ outputDir: dir, bridge: "x-bridge.js", include: () => true });

    expect(readFileSync(p, "utf-8")).toBe("<head></head>");
  });
});

describe("PI_SETTINGS_BRIDGE (#993 phase 2)", () => {
  it("PI_SETTINGS_BRIDGE names the bundle", () => expect(PI_SETTINGS_BRIDGE).toBe("pi-settings-bridge.js"));
});

describe("assertBridgeInjectionPlugin (#993 phase 2)", () => {
  const SDPI = '<script src="sdpi-components.js"></script>';
  const tag = (b: string) => `<script src="${b}"></script>`;
  const expected = (f: string) =>
    f === "settings-window.html" ? "settings-window-bridge.js" : "pi-settings-bridge.js";

  const dirs: string[] = [];

  function tmpDir(): string {
    const d = mkdtempSync(path.join(os.tmpdir(), "ird-assert-"));

    dirs.push(d);

    return d;
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("passes when every page carries exactly its bridge immediately before sdpi", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "car-control.html"), `<head>${tag("pi-settings-bridge.js")}\n    ${SDPI}</head>`);
    writeFileSync(
      path.join(dir, "settings-window.html"),
      `<head>${tag("settings-window-bridge.js")}\n    ${SDPI}</head>`,
    );
    const plugin = assertBridgeInjectionPlugin({ outputDir: dir, expectedBridge: expected });

    await expect(Promise.resolve(plugin.closeBundle.call({}))).resolves.toBeUndefined();
  });

  it("fails on a missing bridge, a doubled bridge, a wrong order, and a second bridge on the same page", async () => {
    const cases = [
      `<head>${SDPI}</head>`,
      `<head>${tag("pi-settings-bridge.js")}\n    ${tag("pi-settings-bridge.js")}\n    ${SDPI}</head>`,
      `<head>${SDPI}\n    ${tag("pi-settings-bridge.js")}</head>`,
      `<head>${tag("pi-settings-bridge.js")}\n    ${SDPI}\n${tag("ulanzi-pi-bridge.js")}</head>`,
    ];
    for (const html of cases) {
      const dir = tmpDir();
      writeFileSync(path.join(dir, "car-control.html"), html);
      const plugin = assertBridgeInjectionPlugin({ outputDir: dir, expectedBridge: expected });

      expect(() => plugin.closeBundle.call({})).toThrow(/car-control\.html/);
    }
  });

  it("accepts any whitespace between the bridge tag and the sdpi tag (indentation is not part of the contract)", () => {
    for (const between of ["", " ", "\n", "\n\t\t", "\r\n        "]) {
      const dir = tmpDir();
      writeFileSync(path.join(dir, "car-control.html"), `<head>${tag("pi-settings-bridge.js")}${between}${SDPI}</head>`);

      expect(() =>
        assertBridgeInjectionPlugin({ outputDir: dir, expectedBridge: expected }).closeBundle.call({}),
      ).not.toThrow();
    }
  });

  it("reports a missing output directory as a bridge-check failure, not an ENOENT", () => {
    const missing = path.join(tmpDir(), "never-created");

    expect(() =>
      assertBridgeInjectionPlugin({ outputDir: missing, expectedBridge: expected }).closeBundle.call({}),
    ).toThrow(/PI bridge injection check failed: output directory .*never-created/);
  });

  it("skips pages without an sdpi tag", () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "plain.html"), "<head></head>");
    expect(() =>
      assertBridgeInjectionPlugin({ outputDir: dir, expectedBridge: expected }).closeBundle.call({}),
    ).not.toThrow();
  });
});
