import globals from 'globals';
import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';
import stylistic from '@stylistic/eslint-plugin';

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
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='useLegacySettingsBehavior']",
          message:
            'Leave the Elgato SDK on its default settings behaviour: the adapter answers getGlobalSettings() from the promise, and the legacy flag would deliver the reply twice (#1208).',
        },
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
          paths: [
            '@iracedeck/iracing-sdk',
            '@iracedeck/iracing-native',
            '@iracedeck/sim-events-iracing',
            '@iracedeck/deck-iracing',
          ].map((name) => ({
            name,
            message:
              'deck-core and the packages split out of it must not depend on a simulator: use the SimConnection interface or an injected delegate, and put iRacing code in @iracedeck/deck-iracing (#1351, #1367).',
          })),
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