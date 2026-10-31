// `getGlobalSettings()` is read as its typed `GlobalSettings` (#1376): an
// assertion on the call, or on the argument an `onGlobalSettingsChange`
// listener receives, hides a renamed or removed key from the compiler. The
// ESLint rule is the guard, and this test proves it fires, so deleting or
// narrowing the rule goes red. The same block re-states the repo-wide
// `useLegacySettingsBehavior` entry (#1208), since a later block's
// `no-restricted-syntax` options replace an earlier one's; that is checked too.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "no-restricted-syntax";
const TIMEOUT = 60_000;
const eslint = new ESLint({ cwd: import.meta.dirname + "/.." });

const IMPORT = `import { getGlobalSettings } from "@iracedeck/settings";\n`;

async function lint(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });

  return result.messages.filter((m) => m.ruleId === RULE);
}

function mentions(messages, text) {
  return messages.filter((m) => m.message.includes(text));
}

describe("global settings cast lint (#1376)", () => {
  const REFUSED = {
    "an `as` assertion": "export const s = getGlobalSettings() as Record<string, unknown>;\n",
    "a double `as unknown as` assertion":
      "export const s = getGlobalSettings() as unknown as Record<string, unknown>;\n",
    "a parenthesised read through `as`":
      "export const v = (getGlobalSettings() as Record<string, unknown>).replayJumpPlayback;\n",
    "an angle-bracket assertion": "export const s = <Record<string, unknown>>getGlobalSettings();\n",
  };

  for (const [name, code] of Object.entries(REFUSED)) {
    it(
      `refuses ${name} on getGlobalSettings() in package source`,
      async () => {
        const messages = await lint(IMPORT + code, "packages/plugin-runtime/src/planted.ts");

        expect(mentions(messages, "#1376")).toHaveLength(1);
      },
      TIMEOUT,
    );
  }

  it(
    "allows the typed read, a declared key and an undeclared passthrough key",
    async () => {
      const messages = await lint(
        IMPORT +
          "export const a = getGlobalSettings().replayJumpPlayback;\n" +
          'export const b = getGlobalSettings()["_devBaseUrl"];\n',
        "packages/plugin-runtime/src/planted.ts",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "allows an assertion on a value read from the settings, not on the call",
    async () => {
      const messages = await lint(
        IMPORT + "export const a = getGlobalSettings().replayJumpPlayback as string;\n",
        "packages/plugin-runtime/src/planted.ts",
      );

      expect(messages).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "allows a test file to shape its mock",
    async () => {
      const messages = await lint(
        IMPORT + "export const s = getGlobalSettings() as Record<string, unknown>;\n",
        "packages/plugin-runtime/src/planted.test.ts",
      );

      expect(mentions(messages, "#1376")).toHaveLength(0);
    },
    TIMEOUT,
  );

  describe("an onGlobalSettingsChange listener's argument", () => {
    const LISTENER = "inside an onGlobalSettingsChange listener";
    const PRELUDE =
      `import { onGlobalSettingsChange } from "@iracedeck/settings";\n` +
      "declare function apply(value: unknown): void;\n" +
      "declare const deps: { onGlobalSettingsChange: (listener: (s: unknown) => void) => () => void };\n";

    const REFUSED_LISTENER = {
      "the scenario harness's `as` on the argument (#1376)":
        "onGlobalSettingsChange((settings) => apply(settings as Record<string, unknown>));\n",
      "the settings-window phase's `as` inside a subscribe wrapper (#1376)":
        "export const host = {\n" +
        "  subscribe: (listener: (s: Record<string, unknown>) => void) =>\n" +
        "    onGlobalSettingsChange((s) => listener(s as Record<string, unknown>)),\n" +
        "};\n",
      "a double `as unknown as` assertion":
        "onGlobalSettingsChange((s) => apply(s as unknown as Record<string, unknown>));\n",
      "an angle-bracket assertion": "onGlobalSettingsChange((s) => apply(<Record<string, unknown>>s));\n",
      "an assertion in a function-expression listener":
        "onGlobalSettingsChange(function (s) {\n  apply(s as Record<string, unknown>);\n});\n",
      "an assertion in a listener handed to an injected onGlobalSettingsChange":
        "deps.onGlobalSettingsChange((s) => apply(s as Record<string, unknown>));\n",
      // The selector cannot tell the argument from another identifier, so this
      // over-reach is part of the rule, pinned so the message stays true for it.
      "an assertion on an unrelated identifier inside the listener":
        "declare const cached: unknown;\nonGlobalSettingsChange((s) => apply(cached as Record<string, unknown>));\n",
    };

    for (const [name, code] of Object.entries(REFUSED_LISTENER)) {
      it(
        `refuses ${name}`,
        async () => {
          const messages = await lint(PRELUDE + code, "packages/plugin-runtime/src/planted.ts");

          expect(mentions(messages, LISTENER)).toHaveLength(1);
          expect(mentions(messages, "#1376")).toHaveLength(1);
        },
        TIMEOUT,
      );
    }

    it(
      "allows the typed argument, a value read from it, a listener passed by name and a cast of an unrelated value",
      async () => {
        const messages = await lint(
          PRELUDE +
            "onGlobalSettingsChange((s) => apply(s));\n" +
            "onGlobalSettingsChange((s) => apply(s.replayJumpPlayback as string));\n" +
            "onGlobalSettingsChange(apply);\n" +
            "declare const stored: unknown;\n" +
            "export const n = stored as number;\n" +
            "export const off = onGlobalSettingsChange(() => apply(n));\n",
          "packages/plugin-runtime/src/planted.ts",
        );

        expect(messages).toHaveLength(0);
      },
      TIMEOUT,
    );

    it(
      "allows a test file to shape its listener's argument",
      async () => {
        const messages = await lint(
          PRELUDE + "onGlobalSettingsChange((s) => apply(s as Record<string, unknown>));\n",
          "packages/plugin-runtime/src/planted.test.ts",
        );

        expect(mentions(messages, "#1376")).toHaveLength(0);
      },
      TIMEOUT,
    );
  });

  for (const filePath of ["packages/plugin-runtime/src/planted.ts", "packages/plugin-runtime/src/planted.test.ts"]) {
    it(
      `still refuses useLegacySettingsBehavior in ${filePath}`,
      async () => {
        const messages = await lint(
          "declare const sdk: { useLegacySettingsBehavior: boolean };\nexport const a = sdk.useLegacySettingsBehavior;\n",
          filePath,
        );

        expect(mentions(messages, "#1208")).toHaveLength(1);
      },
      TIMEOUT,
    );
  }
});
