/**
 * The `bin/` install environment (#1205): every `npm_config_*` key npm does not
 * define goes, everything else the install has always seen stays.
 */
import { describe, expect, it, vi } from "vitest";

import { installRuntimeDeps, npmConfigKey, runtimeInstallEnv, withoutNpmConfig } from "./runtime-install-env.mjs";

/** A slice of what `npm config ls -l --json` lists. */
const DEFINED = new Set(["fund", "globalconfig", "registry", "save-exact"]);

describe("npmConfigKey", () => {
  it("spells keys the way npm's warnings do", () => {
    expect(npmConfigKey("npm_config__jsr_registry")).toBe("_jsr-registry");
    expect(npmConfigKey("npm_config_npm_globalconfig")).toBe("npm-globalconfig");
    expect(npmConfigKey("npm_config_verify_deps_before_run")).toBe("verify-deps-before-run");
  });

  it("reads the prefix case-insensitively, as npm and Windows do", () => {
    expect(npmConfigKey("NPM_CONFIG_AUTO_INSTALL_PEERS")).toBe("auto-install-peers");
  });

  it("is null for any other variable", () => {
    expect(npmConfigKey("PATH")).toBeNull();
    expect(npmConfigKey("npm_package_name")).toBeNull();
  });
});

describe("runtimeInstallEnv", () => {
  it("drops the keys pnpm exports that npm does not define, from pnpm and from any .npmrc", () => {
    const env = {
      npm_config__jsr_registry: "https://npm.jsr.io/",
      npm_config_npm_globalconfig: "C:\\pnpm\\etc\\npmrc",
      npm_config_reporter: "silent",
      npm_config_verify_deps_before_run: "false",
      npm_config_auto_install_peers: "true",
      NPM_CONFIG_SHAMEFULLY_HOIST: "true",
    };

    expect(runtimeInstallEnv(env, DEFINED)).toEqual({});
  });

  it("keeps the keys npm defines, credentials, scoped keys and every other variable", () => {
    const env = {
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_fund: "",
      npm_config_globalconfig: "C:\\pnpm\\config\\rc",
      npm_config__authToken: "t",
      "npm_config_//registry.example/:_authToken": "t",
      npm_package_name: "@iracedeck/plugin",
      PATH: "/usr/bin",
    };

    expect(runtimeInstallEnv(env, DEFINED)).toEqual(env);
  });
});

describe("withoutNpmConfig", () => {
  it("drops every npm_config_ variable and nothing else", () => {
    expect(withoutNpmConfig({ npm_config_registry: "r", NPM_CONFIG_FUND: "", PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
    });
  });
});

describe("installRuntimeDeps", () => {
  const listing = JSON.stringify(Object.fromEntries([...DEFINED].map((key) => [key, null])));

  function io({ exists = true, list = { status: 0, stdout: listing }, install = { status: 0 } } = {}) {
    const run = vi.fn((command) => (command === "npm install" ? install : list));
    return { env: { npm_config_registry: "r", npm_config_reporter: "silent", PATH: "p" }, exists: () => exists, run, log: vi.fn() };
  }

  it("installs in the bin folder with only npm's keys, listing them with none", () => {
    const deps = io();

    expect(installRuntimeDeps("bin", deps)).toBe(0);
    expect(deps.run).toHaveBeenNthCalledWith(1, "npm config ls -l --json", { env: { PATH: "p" }, capture: true });
    expect(deps.run).toHaveBeenNthCalledWith(2, "npm install", {
      cwd: "bin",
      env: { npm_config_registry: "r", PATH: "p" },
      capture: false,
    });
  });

  it("passes npm install's exit status through", () => {
    expect(installRuntimeDeps("bin", io({ install: { status: 3 } }))).toBe(3);
  });

  it("names a missing bin folder instead of spawning", () => {
    const deps = io({ exists: false });

    expect(installRuntimeDeps("bin", deps)).toBe(1);
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("bin does not exist"));
  });

  it("fails rather than installing with an unfiltered environment when npm cannot list its keys", () => {
    for (const list of [{ status: 1 }, { status: 0, stdout: "not json" }, { status: null, error: new Error("ENOENT") }]) {
      const deps = io({ list });

      expect(installRuntimeDeps("bin", deps)).toBe(1);
      expect(deps.run).toHaveBeenCalledTimes(1);
    }
  });

  it("asks for a folder when given none", () => {
    expect(installRuntimeDeps(undefined, io())).toBe(2);
  });
});
