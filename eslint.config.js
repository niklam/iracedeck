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
    // handing deck-core's one-time host migration the answer twice.
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
    ignores: ['**/dist/**', '**/node_modules/**', '**/build/**']
  },
];