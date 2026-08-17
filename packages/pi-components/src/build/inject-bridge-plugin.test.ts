import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { injectBridgeScriptPlugin } from "./inject-bridge-plugin.mjs";

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
