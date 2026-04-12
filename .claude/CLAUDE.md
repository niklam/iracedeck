# iRaceDeck — Project memory

Project-wide instructions and overview for iRaceDeck. See the `.claude/rules/` directory for focused, topic-specific rules (code style, testing, icons, Stream Deck actions, build & commit conventions, etc.).

Packages

- `@iracedeck/logger`
- `@iracedeck/iracing-native` — has its own `CLAUDE.md` documenting native keyboard functions
- `@iracedeck/iracing-sdk`
- `@iracedeck/icon-composer` — Standalone SVG icon assembly with zero dependencies. Contains all pure assembly functions (assembleIcon, resolveIconColors, resolveTitleSettings, resolveBorderSettings, resolveGraphicSettings, etc.). Re-exported by deck-core for backward compatibility.
- `@iracedeck/deck-core` — Platform-agnostic base classes, types, and shared utilities (base actions, keyboard service, global settings, icon templates, etc.). Re-exports icon-composer and adds global settings readers.
- `@iracedeck/deck-adapter-elgato` — Elgato Stream Deck adapter bridging the Elgato SDK to deck-core's `IDeckPlatformAdapter` interface; also provides `createSDLogger`
- `@iracedeck/deck-adapter-mirabox` — Mirabox adapter bridging the VSD Craft WebSocket protocol to deck-core's `IDeckPlatformAdapter` interface
- `@iracedeck/actions` — All action implementations; import from `@iracedeck/deck-core` (not `@elgato/streamdeck`)
- `@iracedeck/stream-deck-plugin` — has its own `CLAUDE.md` with step-by-step instructions for adding new actions. Registers actions from `@iracedeck/actions` via `ElgatoPlatformAdapter`. The `src/shared/index.ts` re-exports from `@iracedeck/deck-core` and `@iracedeck/deck-adapter-elgato` for backward compatibility.
- `@iracedeck/mirabox-plugin` — Registers actions from `@iracedeck/actions` via `VSDPlatformAdapter` for Mirabox devices. Has its own `CLAUDE.md` documenting differences from the Elgato plugin.
- `@iracedeck/website`

High-level guidance

- Follow rule files in `.claude/rules/` for granular conventions.
- Keep rules focused: one topic per markdown file.
- Use `paths` frontmatter in rules when a rule applies only to certain files.
- **Keep documentation in sync with reality.** When code changes alter conventions, patterns, APIs, or workflows described in any `CLAUDE.md` or `.claude/rules/` file, update those files in the same change. Stale instructions cause repeated mistakes.
- **Keep `README.md` in sync with reality.** When changes affect the project structure, action count, features, or development workflow described in `README.md`, update it in the same change.

Cross-platform development

This project supports development on both Windows and macOS. The native addon (`@iracedeck/iracing-native`) automatically uses a mock implementation on non-Windows platforms. See the `cross-platform-development` skill and `packages/iracing-native/CLAUDE.md` for details.

How to import or reference

You can import or reference specific rule files from other markdown using `@.claude/rules/<file>.md` if needed.

## Rule files

- `action-documentation.md`: How to document Stream Deck actions: settings tables, keyboard simulation tables, icon state tables, and the reference template.
- `black-box-icons.md`: Design guidelines for iRacing black box key icons: canvas layout, inner frame spec, text labels, layout patterns, and per-icon details. Scoped to black-box-selector files.
- `build-and-commit.md`: Worktree-based development workflow, pre-commit checks (`pnpm install` + `pnpm build`), build commands, conventional commit conventions, and post-merge worktree cleanup.
- `code-style.md`: Formatting, linting, type conventions, Zod usage, and general code quality rules.
- `global-settings.md`: Plugin-level global settings architecture: Property Inspector usage, `ird-key-binding` with `global` attribute, Zod schema, and settings path conventions.
- `icons.md`: General icon guidelines: icon types (category, key, template), SVG structure, design specs, color palette, Mustache templates, and distinctiveness rules.
- `key-icon-types.md`: Standardized key icon type definitions (Default, Black Box, Inverted): canvas layout, two-line label system, Standard vs Inverted label layouts, per-action background colors, and icon content separation patterns. Scoped to icon SVG/TS files.
- `keyboard-shortcuts.md`: SDK-first principle, key binding architecture, Property Inspector setup for `ird-key-binding`, Zod schemas for key bindings, sending key combinations (tap and long-press/hold), global vs per-action bindings, and cross-package sync rules.
- `logging.md`: Log levels, info vs debug separation, `createScope()` usage, and dependency-injected logger patterns.
- `pi-templates.md`: EJS templates for Property Inspector HTML: directory structure, available partials, Rollup plugin config, key bindings JSON format.
- `plugin-structure.md`: Plugin package naming conventions, Rollup config, native module handling (`keysender`), app monitoring, and critical initialization order in `plugin.ts`.
- `sdpi-components.md`: Comprehensive reference for the `sdpi-components` web component library used in all Property Inspectors: every component's attributes and value types, Stream Deck client communication helpers, data sources, and localization. Scoped to PI files.
- `stream-deck-actions.md`: Action requirements (`ConnectionStateAwareAction`), SDK-first principle, PI components (`sdpi-select` quirks, conditional visibility), global settings setup, and encoder support.
- `terminology-and-refs.md`: Project terminology (Property Inspector, Key Icon, Encoder, Action ID) and external reference links.
- `testing.md`: Vitest conventions, test file naming, mocking patterns for Stream Deck SDK, and action test structure.
- `svg-platform-compatibility.md`: SVG feature support across platforms (QT5 SVG Tiny 1.2 for Mirabox vs QT6.7+ for Elgato): safe features, Elgato-only features, unsupported features, and guidelines for new icons.
- `website-action-docs.md`: Website action documentation format: per-mode sections with self-contained settings, encoder info, and h5 setting subheaders. Scoped to website action pages. Canonical example: tire-service.md.
