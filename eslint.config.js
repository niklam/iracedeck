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
    ignores: ['**/dist/**', '**/node_modules/**', '**/build/**']
  },
];