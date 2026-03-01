# iRaceDeck — Project memory

Project-wide instructions and overview for iRaceDeck. See the `.claude/rules/` directory for focused, topic-specific rules (code style, testing, icons, Stream Deck actions, build & commit conventions, etc.).

Packages

- `@iracedeck/logger`
- `@iracedeck/iracing-native` — has its own `CLAUDE.md` documenting native keyboard functions
- `@iracedeck/iracing-sdk`
- `@iracedeck/stream-deck-shared`
- `@iracedeck/stream-deck-plugin-core` — has its own `CLAUDE.md` with step-by-step instructions for adding new actions
- `@iracedeck/website`

High-level guidance

- Follow rule files in `.claude/rules/` for granular conventions.
- Keep rules focused: one topic per markdown file.
- Use `paths` frontmatter in rules when a rule applies only to certain files.
- **Keep documentation in sync with reality.** When code changes alter conventions, patterns, APIs, or workflows described in any `CLAUDE.md` or `.claude/rules/` file, update those files in the same change. Stale instructions cause repeated mistakes.

Cross-platform development

This project supports development on both Windows and macOS. The native addon (`@iracedeck/iracing-native`) automatically uses a mock implementation on non-Windows platforms. See the `cross-platform-development` skill and `packages/iracing-native/CLAUDE.md` for details.

How to import or reference

You can import or reference specific rule files from other markdown using `@.claude/rules/<file>.md` if needed.

## Rule files

- `action-documentation.md`: How to document Stream Deck actions: settings tables, keyboard simulation tables, icon state tables, and the reference template.
- `black-box-icons.md`: Design guidelines for iRacing black box key icons: canvas layout, inner frame spec, text labels, layout patterns, and per-icon details. Scoped to black-box-selector files.
- `build-and-commit.md`: Build commands (`pnpm build`, shortcuts) and conventional commit conventions.
- `code-style.md`: Formatting, linting, type conventions, Zod usage, and general code quality rules.
- `global-settings.md`: Plugin-level global settings architecture: Property Inspector usage, `ird-key-binding` with `global` attribute, Zod schema, and settings path conventions.
- `icons.md`: General icon guidelines: icon types (category, key, template), SVG structure, design specs, color palette, Mustache templates, and distinctiveness rules.
- `key-icon-types.md`: Standardized key icon type definitions (Default, Black Box, Inverted): canvas layout, two-line label system, Standard vs Inverted label layouts, per-action background colors, and icon content separation patterns. Scoped to icon SVG/TS files.
- `keyboard-shortcuts.md`: SDK-first principle, key binding architecture, Property Inspector setup for `ird-key-binding`, Zod schemas for key bindings, sending key combinations (tap and long-press/hold), global vs per-action bindings, and cross-package sync rules.
- `logging.md`: Log levels, info vs debug separation, `createScope()` usage, and dependency-injected logger patterns.
- `pi-templates.md`: EJS templates for Property Inspector HTML: directory structure, available partials, Rollup plugin config, key bindings JSON format.
- `plugin-structure.md`: Plugin package naming conventions, Rollup config, native module handling (`keysender`), app monitoring, and critical initialization order in `plugin.ts`.
- `stream-deck-actions.md`: Action requirements (`ConnectionStateAwareAction`), SDK-first principle, PI components (`sdpi-select` quirks, conditional visibility), global settings setup, and encoder support.
- `terminology-and-refs.md`: Project terminology (Property Inspector, Key Icon, Encoder, Action ID) and external reference links.
- `testing.md`: Vitest conventions, test file naming, mocking patterns for Stream Deck SDK, and action test structure.
