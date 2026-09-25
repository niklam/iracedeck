/**
 * The `bin/` install environment (#1205): pnpm's own keys go, everything else
 * the install has always seen stays.
 */
import { describe, expect, it } from "vitest";

import { PNPM_ONLY_NPM_CONFIG_KEYS, runtimeInstallEnv } from "./runtime-install-env.mjs";

describe("runtimeInstallEnv", () => {
  it("drops every pnpm-only key npm warns about", () => {
    const env = Object.fromEntries(PNPM_ONLY_NPM_CONFIG_KEYS.map((key) => [key, "x"]));

    expect(runtimeInstallEnv(env)).toEqual({});
  });

  it("matches the keys case-insensitively, as Windows does", () => {
    expect(runtimeInstallEnv({ NPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false" })).toEqual({});
  });

  it("keeps the npm settings the install runs with and everything else", () => {
    const env = {
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_fund: "",
      npm_config_globalconfig: "C:\\pnpm\\config\\rc",
      PATH: "/usr/bin",
    };

    expect(runtimeInstallEnv({ ...env, npm_config__jsr_registry: "https://npm.jsr.io/" })).toEqual(env);
  });

  it("leaves its input untouched", () => {
    const env = { npm_config_npm_globalconfig: "x" };

    runtimeInstallEnv(env);

    expect(env).toEqual({ npm_config_npm_globalconfig: "x" });
  });
});
