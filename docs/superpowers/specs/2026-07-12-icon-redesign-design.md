# Icon Redesign (#827) — Design Spec

Approved interactively by Niklas on 2026-07-12 through per-set browser galleries (visual companion session `.superpowers/brainstorm/2086-1783862936/content/`, local only). Every set below was reviewed icon-by-icon and iterated to approval; this document records the final system and per-icon compositions the implementation must reproduce.

## Goal

Redesign the key icons for 16 icon sets (~172 template SVGs) in a new rich visual language ("Track B"): filled shapes with gradient shading, highlights, and glows rendered by resvg (#642), replacing the flat thin-stroke language. Also consolidate the duplicated FFB Max Force mode from Cockpit Misc into Force Feedback.

## Scope decisions made during design review

- **In scope**: Force Feedback, Media Capture, Camera Editor Adjustments, Look Direction, Cockpit Misc (only dash-page-1 ±, dash-page-2 ±, in-lap-mode; ffb-max-force moves out), Telemetry Control, Setup Aero/Brakes/Chassis/Engine/Fuel/Hybrid/Traction, Chat (static icons only), View Adjustment, Black Box Selector (all 13, plus its rule file `black-box-icons.md`).
- **Out of scope by explicit decision**: Chat send-message and macro inline templates in `chat.ts` (stay exactly as-is); the Replay Slower turtle (original kept); Cockpit Misc wipers + report-latency icons.
- **`pngRasterization` kill-switch is NOT a design constraint** (Niklas, 2026-07-12): filters/masks/clipPath/gradients may carry essential visual information. Ulanzi breakage is acceptable loss. Still avoid `<style>`, animations, scripting; text anchors at baseline (no `dominant-baseline`).

## Design system

### Palette and materials (fixed literals unless noted)

| Material | Definition |
|----------|------------|
| Metal (`mtl`) | vertical linear gradient `#e8eef2 → #8fa3ad` — primary filled artwork |
| Lens glass (`lns`) | radial `#8ed4ff → #2c5f9e → #122c4d`, highlight dot `#fff` @ .85 |
| Disc (`disc`) | radial `#f0f4f7 → #93a5af → #5c6d77` (brake discs) |
| Tire (`tireG`) | radial `#4a5560 → #20262c` |
| Amber (`ambG`) | `#f7d94c → #d9980f` (fuel, flags, warnings, A-badge) |
| Red (`redG`) | `#ff6b5e → #c0392b` (REC, calipers, red zones) |
| Green (`plusG`) | `#4be08d → #1d9e58` (plus chips, battery charge, checks) |
| Minus red (`minusG`) | `#f47c6a → #c0392b` (minus chips) |
| Dark glass (`dgl`) | `#24425e → #0d1f30` (displays, windows) |
| Accent | `#4fc3f7` cyan — the "adjusted dimension" marker, arcs, arrows, traces |
| Glow | `feGaussianBlur stdDeviation="3"` behind glowing elements (duplicate element, blurred copy under sharp copy) |

### Customization (color slots)

- `{{backgroundColor}}` / `{{textColor}}` behave as today (per-set defaults unchanged — see `icon-defaults.json`).
- `{{graphic1Color}}` (default `#ffffff`) drives the primary **metal** artwork: implement metal shapes as base fill `{{graphic1Color}}` plus fixed shading overlays (duplicate shape with a fixed black gradient `transparent → rgba(0,0,0,.45)` and a top sheen `rgba(255,255,255,.25) → transparent`), so any user color gets the dimensional treatment. With the white default this reproduces the approved `mtl` look.
- Semantic colors (chips, amber, red, green, cyan accent, tire-state colors, lens glass) are **fixed literals**; declare `"locked":["graphic1Color"]` only where the icon would break under global recolor of its primary artwork (follow current per-icon locking; do not add new locks wholesale).
- Cutout shapes that expose the key background (momo-wheel windows, gear hub, tape-roll center) use `{{backgroundColor}}`.

### System marks

- **Direction chip**: circle r≈10 at bottom-right (≈80,60 in a 96-wide frame), `plusG` with white `+` or `minusG` with white `−`, ringed by a `{{backgroundColor}}` stroke. All ± modes carry it; ± pairs share artwork unless listed under "direction-aware artwork".
- **"A" badge (auto/magic)**: amber circle with dark bold `A`. In the chip slot when the mode is non-directional (auto-compute-ffb-force); top-right when the mode also has a chip (auto-set-mic-gain ±). Rule: any current or future automatic/computed mode carries it.
- **Tri-state toggles** (the DRS / Fast Repair pattern): telemetry-aware toggles render a full-width bottom status bar (`statusBarOn/Off/NA` — green ON / red OFF / gray N/A) + state-driven border. Applied to **abs-toggle** (glyph: the ISO ABS symbol — circle + `ABS` text + two side bracket arcs pulled close) and **tc-toggle** (glyph: big bold `TC` text only). State sources: `dcABS` for ABS; TC uses the best available source, else N/A.
- **Direction-aware artwork** (sign changes the drawing, chip still present): camera-editor **pitch** (single arrowhead up/down on the arched arc), brake **bias/bias-fine** (knob on F end for +, R end for −; layout R-left F-right), view **fov** (wide/narrow cone), **horizon** (line high/low, ground fill follows, rim drawn last, fixed white center marker), **driver-height** and **ui-size** (before→after: dim small → arrow → bright large for +, reversed for −).
- **Titles**: rendered by the title system from `<desc>` title metadata as today; keep current title texts except where a mode's label changed during review (e.g. in-lap board reads "IN LAP" *inside the artwork*). Two-line `"<NAME>\n+"` style for ± pairs matches current conventions.
- **SVG format**: trimmed-viewBox graphic snippets, no background rect, no title text elements, `<desc>` JSON (colors/title/border, current border colors per set kept). Gradients/filters defined per-file in `<defs>` with short local ids.

## Per-set compositions (approved reference)

The authoritative shapes live in the generator scripts used to produce the approved galleries; implementation converts them 1:1 to repo-format SVGs (strip 96×96 background + title text, keep artwork + chip, trim viewBox, add `<desc>` + Mustache slots).

### Force Feedback (11) — `ff` gallery v5
Momo wheel (circular rim, T-spokes, hub — from the Camera Cockpit icon) is the family mark. auto-compute: wheel + both-ways arc + "Nm" weight + amber A badge in chip slot. ffb-force ±: same artwork + chips (this pair is the consolidated FFB Max Force home). wheel-lfe ±: wheel + 3 vibration arcs. wheel-lfe-intensity ±: wheel + growing sine. bass-shaker-lfe ±: subwoofer box (cone, dome, corner screws) + arcs. haptic-lfe-intensity ±: haptic puck + radiating waves both sides.

### Media Capture (7) — `media` gallery v1
Movie camera (top reels, silver body, dark-gray lens prism `#5c6a78 → #28313a` with lighter front rim) for video modes; badge per mode: glowing REC dot / mini stopwatch / green power symbol. Still camera (purple-gray body, glass lens) + amber sparkle for screenshots; giant = 0.78-scale camera inside four corner brackets. Reloads: cyan refresh arrows over 2×2 texture tiles / top-view car.

### Camera Editor Adjustments (30) — `camedit` gallery v2
Per-setting metaphors, accent marks the adjusted dimension: glass globe with parallels (latitude) / meridians (longitude); camera on dashed height line over ground (altitude); top-view camera + rotation ring (yaw); side camera + vertical arc, single head per sign (pitch); camera at light-cone apex (fov-zoom); keycap + staircase (key-step); converging lines to glowing dot, horizontal/vertical accent axis (vanish-x/y); airship on dashed orbit + radius line (blimp-radius); airship + speed lines (blimp-velocity); mic + gain arcs (mic-gain; auto-set adds top-right A badge); aperture blades around glass opening (f-number); sharp accent dot between two blurred dots in focus brackets (focus-depth).

### Look Direction (4) — `fixes-round4` + eye-v5
Filled eye: tall asymmetric almond (deep top-lid arc), sclera gradient, amber-core/blue-rim iris as foreshortened ellipse clipped inside the lids (clipPath), pupil offset to the leading edge, catchlight up-left, clipped top-lid shadow, thin lash outline. Left/Right: iris center 4px in from the corner-touching position (Left cx=31, Right cx=65 of 96), no sclera visible in the look direction. Up/Down: iris buried under the lid. Glowing cyan chevron on the looked-at edge.

### Cockpit Misc (5) — `cockpit-tele` v3
Dash pages: glass display with **text-style rows** (dim label bars, amber `12.5`, cyan `98°`), blue page-number badge (1/2), chips. In-lap-mode: pit board reading "IN LAP" (amber on dark board, metal frame), centered, pole below. ffb-max-force icons are **removed** from this set (consolidation).

### Telemetry Control (6) — `cockpit-tele` v3
Telemetry trace (axes + cyan squiggle) family mark. toggle-logging: + glowing REC dot. mark-event: + amber pennant pinned on a dashed vertical through the trace. start/stop/restart-recording: + green play / red stop / amber restart-loop badge. snapshot: squiggle over a glowing green **download arrow into an open tray** (save-a-file, from the current icon's idea).

### Setup Aero (7) — `setup1` v4
Wings as hero (front view): front-wing = nose cone over wide low wing + endplates + flank airflow; rear-wing = tall endplates, stacked flap/main plane on center pylon, airflow arc over the top. qualifying-tape = white tape strip diagonally across a slatted radiator grille + tape roll. rf-brake-attached = corner-map car with RF lit + small brake disc.

### Setup Brakes (13) — `setup1` v4
Distinct primary artwork per mode: bias ± = two discs + balance bar, **R left / F right**, knob on the sign's end; bias-fine ± = same + magnifier following the knob; peak-brake-bias ± = pressure trace peaking at amber dot; brake-misc ± = big disc + caliper + three dots; engine-braking ± = engine block + left chevrons + small disc; abs-toggle = ISO ABS symbol + tri-state bar; abs-adjust ± = ISO ABS symbol + chips.

### Setup Chassis (26) — `chassis` gallery v1
Corner-map system: shocks light one corner + coil-with-rod glyph; springs light the side pair + pure coil with end plates; ARBs light the axle + U-bar with drop links; diffs light the driveline + gear, distinguished by badge — inward squeeze arrows (preload) or corner-arc with dot at entry/apex/exit; power-steering = momo wheel + amber bolt.

### Setup Engine (8) — `setup1` v4
engine-power ± = block + bolt; throttle-shaping ± = angled pedal + throttle-map curve; boost-level ± = turbo volute (spiral accent, impeller pinwheel, tapered outlet duct with flow chevrons); launch-rpm ± = gauge with red zone + needle.

### Setup Fuel (7) — `setup3` v2
Amber droplet family mark: mixture ± = droplet + lean/rich dial; fuel-cut-position ± = droplet + inline bowtie valve; disable-fuel-cut = valve + red no-badge; low-fuel-accept = warning droplet + glowing green check; fcy-mode-toggle = droplet + waving yellow flag on pole.

### Setup Hybrid (9) — `setup3` v2
Battery (terminal + green charge fill) family mark: hys-boost = + bolt; hys-regen = + green arrow charging into the pack; hys-no-boost = grayed bolt in red no-circle; mguk-regen-gain ± = + circular green arrows; mguk-deploy-mode ± = + rotary selector dial with dots; mguk-fixed-deploy ± = + padlock.

### Setup Traction (9) — `setup3` v2 (+ TC fix in `chat-view` v4)
tire + grip arcs family mark, blue slot badge numbering TC1–TC4 for tc-slot-1..4 ±; tc-toggle = big `TC` text + tri-state bar.

### Chat (6) — `chat-view` v4
Filled bubble (sclera gradient + tail) family mark: whisper = quiet speaker + single wave **inside** the bubble; open-chat = I-beam cursor; reply = curved reply arrow (respond-pm keeps aliasing reply's icon); toggle = green power symbol inside the bubble; cancel = red X. send-message/macro inline templates unchanged.

### View Adjustment (9) — `chat-view` v4
fov ± = light cone wide/narrow + angle arc (no camera at apex — distinguishes from Camera Editor fov-zoom); horizon ± = attitude indicator, horizon line high/low with ground fill, fixed white center marker, rim drawn last; driver-height ± = dim small figure → cyan arrow → bright tall figure (reversed for −); ui-size ± = same before→after pattern with windows; recenter-vr = headset with glass lenses + dashed centering ring + top tick.

### Black Box Selector (13) — `blackbox` v6
Family frame: olive glass `#453a1c → #221a0a`, stroke `#6a5138`, no top highlight bar. Contents in natural data colors: fuel = droplet + amber `12.5` + level bar; tires = 4 corner blocks (green/green/amber/red) + axle cross; tire-info = tread cross-section + I/M/O temp bars; pit-stop = crossed wrench + screwdriver (X, per Niklas's reference), 0.8 scale, fully inside the frame; lap-timing = small stopwatch (r≈10.5) + amber `1:23.4`; in-car = momo wheel + two slider tracks; mirror = wide mirror filling the frame, top mount tab, glass gradient, reflection streaks (current layout; note: shipped title text is "GRAPHICS" — verify correct label during implementation); radio = mic + amber level bars; relative = three rows, middle amber (you); standings = podium bars with amber "1"; weather = small cloud + rain (clear of the border); next/previous = double chevrons. Update `.claude/rules/black-box-icons.md` to this spec (frame colors, no fixed 114×58 requirement, per-icon content).

## Non-icon changes

1. **FFB Max Force consolidation**: hide `ffb-max-force` from the Cockpit Misc PI Mode dropdown but keep the mode functional for existing buttons (precedent: Pit Crew `radar-volume` #590, Chat `respond-pm`); its icon imports switch to the Force Feedback `ffb-force` artwork. Force Feedback's `ffb-force` PI labels get a "(max force)" clarification. Comms catalog already maps both to the same bindings; regenerate `action-comms.json` if descriptors change. Update mode tables/counts everywhere (docs, website, `iracedeck-actions` skill, `actions.json`).
2. **abs-toggle / tc-toggle tri-state**: setup-brakes and setup-traction actions render the toggle modes with `statusBarOn/Off/NA` + `borderColorForState` (state from `dcABS` / best TC source, else N/A), like DRS.
3. **Chat static icons**: swap the five imported SVGs; send-message/macro templates untouched.
4. **Per-action statics**: refresh `icon.svg` (20×20 category) and `key.svg` (72×72) for the 16 affected actions to feature the new family mark; setup actions' `dial.svg` likewise.
5. **Docs/website/skills**: action doc icon tables, website action pages, changelog entry (one line), `iracedeck-actions` SKILL.md + `actions.json`, `black-box-icons.md`; `icons.md`/`key-icon-types.md` gain the design-system section (chips, A badge, tri-state, materials).
6. **Regeneration**: `node scripts/generate-icon-previews.mjs` and `node scripts/generate-icon-defaults.mjs`; freshness tests must pass.

## Verification

`pnpm build`, `pnpm lint`, `pnpm test` all green (no watcher); previews regenerated; manual visual pass of `packages/icons/preview/**` against the approved galleries; Niklas does the final on-device test before push/PR (per standing workflow).

## Post-device-test revision (2026-07-12, Niklas review)

- **Tight per-icon viewBoxes**: the initial uniform `0 0 96 72` box left large margins on many keys (FFB pair most visibly). Every icon's viewBox is now the resvg-rendered alpha bounding box of its artwork plus 1 unit of padding, so artwork fills the key.
- **`{{graphic2Color}}` accent slot**: the cyan accent (`#4fc3f7`) across all sets is the graphic2 slot (declared in each `<desc>`, default preserved); chat maps its in-bubble blue (`#2563ab`) to the same slot. The eye sclera and chat bubble are `{{graphic1Color}}`-driven (`scl2` gradient at opacity 1 → 0.76), so Look Direction and Chat respond to color customization. PI `color-overrides` slot lists extended accordingly (black-box gains graphic1+graphic2).
