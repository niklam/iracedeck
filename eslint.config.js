import globals from 'globals';
import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';
import stylistic from '@stylistic/eslint-plugin';

// The iRacing packages a sim-neutral layer may not import: deck-core and the
// packages split out of it (#1351, #1367) and the device shells (#1500).
const SIM_PACKAGES = [
  '@iracedeck/deck-iracing',
  '@iracedeck/sim-events-iracing',
  '@iracedeck/iracing-sdk',
  '@iracedeck/iracing-native',
];
const SHELL_SIM_MESSAGE =
  'A plugin shell must not depend on a simulator: read the sim through PluginExtensionContext.sim, which plugin-runtime hands PluginExtension.start (#1500).';

// Repo-wide (#1208); spread into every block that sets no-restricted-syntax, since a
// later block's options replace an earlier one's rather than merging with them.
const NO_LEGACY_SETTINGS_BEHAVIOR = {
  selector: "MemberExpression[property.name='useLegacySettingsBehavior']",
  message:
    'Leave the Elgato SDK on its default settings behaviour: the adapter answers getGlobalSettings() from the promise, and the legacy flag would deliver the reply twice (#1208).',
};

export default [
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      globals: {
        ...globals.node,
      }
    },
    plugins: {
      '@typescript-eslint': tseslint,
      '@stylistic': stylistic,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "no-undef": 'off',
      'no-redeclare': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@stylistic/padding-line-between-statements': [
          "error",
          { blankLine: "always", prev: "*", next: "return" },
          { blankLine: "always", prev: "*", next: ["if", "switch", "for", "while", "do", "try", "with"] },
          { blankLine: "always", prev: ["if", "switch", "for", "while", "do", "try", "with"], next: "*" },
      ]
    },
  },
  {
    // Repo tooling (scripts/, rollup configs, the PI compile plugin) is plain ESM
    // running under Node. Without this, `eslint.configs.recommended` above applies
    // no-undef with no globals declared and every `console` / `process` / `URL`
    // in a .mjs file is an error the moment anyone points ESLint at one.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  prettier,
  {
    // The Elgato adapter delivers a global-settings read's answer from the SDK
    // promise (#1208). SDK 3.0's legacy flag would ALSO fire the event for it,
    // handing `@iracedeck/settings`' one-time host migration the answer twice.
    files: ['**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', NO_LEGACY_SETTINGS_BEHAVIOR],
    },
  },
  {
    // `getGlobalSettings()` returns the typed `GlobalSettings`, whose passthrough
    // index signature already admits an undeclared key (#1376). An assertion on
    // the call hides a renamed or removed key from the compiler, so read the
    // typed value instead. Tests may shape their mocks as they like.
    //
    // A listener handed to `onGlobalSettingsChange` receives the same typed
    // settings, so a cast of its argument hides a key just as surely — the
    // shape #1376 removed from plugin-runtime's settings-window phase and the
    // scenario harness. esquery cannot tie an assertion's operand to the
    // listener's first parameter, so the second selector refuses an `as` or
    // `<T>` assertion on any bare identifier inside a function passed
    // straight to `onGlobalSettingsChange(…)` or `<deps>.onGlobalSettingsChange(…)`;
    // a cast of a value read from the settings (`s.key as T`) passes, as it
    // does on the call. Deliberately not covered: the settings held in a
    // variable first (`const s = getGlobalSettings(); s as …`), because a
    // selector sees syntax, not what a variable holds, and a listener passed
    // by name, whose parameter is typed where it is declared. Nor is widening
    // the compiler accepts without a cast (a `Record<string, unknown>`
    // parameter or annotation), so this is a guard on the common shape, not a
    // complete one.
    // scripts/global-settings-cast-lint.test.mjs proves both selectors fire.
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/*/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        NO_LEGACY_SETTINGS_BEHAVIOR,
        ...['TSAsExpression', 'TSTypeAssertion'].map((node) => ({
          selector: `${node} > CallExpression.expression[callee.name='getGlobalSettings']`,
          message:
            'Read getGlobalSettings() as its typed GlobalSettings: an assertion hides a renamed or removed key from the compiler, and an undeclared passthrough key already reads as unknown (#1376).',
        })),
        ...['TSAsExpression', 'TSTypeAssertion'].map((node) => ({
          selector:
            "CallExpression:matches([callee.name='onGlobalSettingsChange'], [callee.property.name='onGlobalSettingsChange'])" +
            ` > :function.arguments ${node} > Identifier.expression`,
          message:
            "Read an onGlobalSettingsChange listener's argument as its typed GlobalSettings: an assertion on it hides a renamed or removed key from the compiler, and an undeclared passthrough key already reads as unknown (#1376).",
        })),
      ],
    },
  },
  {
    // deck-core is the deck layer: it sees a simulator only through its
    // SimConnection interface. iRacing lives in @iracedeck/deck-iracing (#1351).
    // The packages split out of deck-core keep the same boundary (#1367): what
    // they need from the sim is injected by plugin-runtime or fed by deck-iracing.
    // scripts/deck-core-sim-boundary.test.mjs proves this rule fires in each.
    files: [
      'packages/deck-core/src/**/*.ts',
      'packages/replay-store/src/**/*.ts',
      'packages/diagnostics/src/**/*.ts',
      'packages/app-updates/src/**/*.ts',
      'packages/settings-window/src/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: SIM_PACKAGES.map((name) => ({
            name,
            message:
              'deck-core and the packages split out of it must not depend on a simulator: use the SimConnection interface or an injected delegate, and put iRacing code in @iracedeck/deck-iracing (#1351, #1367).',
          })),
        },
      ],
    },
  },
  {
    // The Race Engineer catalog reads the sim only through the deps registerPitCrew
    // is handed (#1378): the translator's types may be named, never its getters
    // called, and the deck and native layers not reached at all. Lint sees imports,
    // not calls, so this is a ratchet on direct imports; a transitive read is
    // caught by the families' required deps types instead. Tests and their utils
    // may import what they like.
    files: ['packages/audio-scenarios/src/**/*.ts'],
    ignores: ['packages/audio-scenarios/src/**/*.test.ts', 'packages/audio-scenarios/src/**/*.test-util.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@iracedeck/sim-events-iracing',
              allowTypeImports: true,
              message:
                'The Race Engineer catalog reads the sim only through its injected deps: import the translator\'s types with `import type`, and take a read through PitCrewDeps (#1378).',
            },
            ...['@iracedeck/deck-iracing', '@iracedeck/iracing-native'].map((name) => ({
              name,
              message:
                'The Race Engineer catalog must not reach the deck layer or the native addons: take what it needs through PitCrewDeps (#1378).',
            })),
          ],
        },
      ],
    },
  },
  {
    // The replay engine is iRacing's, not the deck's (#1467): what it needs from the deck
    // layer and the settings is injected by plugin-runtime's initReplay phase.
    // scripts/replay-engine-boundary.test.mjs proves this rule fires.
    files: ['packages/replay-engine/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@iracedeck/deck-core',
                '@iracedeck/deck-iracing',
                '@iracedeck/settings',
                '@iracedeck/icons',
                '@iracedeck/icons/*',
                '@iracedeck/iracing-actions',
              ],
              message:
                'The replay engine must not depend on the deck layer, the settings or its own consumers: take it through configureReplayEngine (#1467).',
            },
          ],
        },
      ],
    },
  },
  {
    // A device shell names its host and calls startPlugin; it reaches no sim
    // package (#1500). What a host extension reads of the sim arrives in its
    // start context, PluginExtensionContext.sim, which plugin-runtime's initSim
    // builds. Type-only imports and tests included: neither needs one. The
    // subpath pattern closes a deep import, which iracing-sdk and iracing-native
    // allow because they declare no `exports`.
    // scripts/plugin-shell-sim-boundary.test.mjs proves this rule fires.
    files: ['packages/iracing-plugin-*/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: SIM_PACKAGES.map((name) => ({ name, message: SHELL_SIM_MESSAGE })),
          patterns: [{ group: SIM_PACKAGES.map((name) => `${name}/*`), message: SHELL_SIM_MESSAGE }],
        },
      ],
    },
  },
  {
    // The root Vitest config is loaded with `configLoader: 'native'` (see
    // .claude/rules/testing.md), so Node strips its types itself: CommonJS
    // globals do not exist there, and a type-only import missing the `type`
    // modifier becomes a value import of an export that does not exist.
    // Enforce both here so a re-break fails lint instead of the test suite.
    files: ['vitest.config.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-restricted-globals': [
        'error',
        { name: '__dirname', message: 'Use import.meta.dirname — this config is loaded natively as ESM.' },
        { name: '__filename', message: 'Use import.meta.filename — this config is loaded natively as ESM.' },
      ],
    },
  },
  {
    // Only node-gyp's output roots, mirroring .gitignore: a bare `**/build/**` also hid the
    // source under packages/*/src/build/ (#1125). scripts/lint-format-ignores.test.mjs guards it.
    ignores: ['**/dist/**', '**/node_modules/**', 'build/**', 'packages/*/build/**']
  },
];