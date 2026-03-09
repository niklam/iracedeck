# Changelog

## [0.11.0](https://github.com/niklam/iracedeck/compare/v0.10.1...v0.11.0) (2026-03-08)

### Features

* **iracing-sdk:** add template variable system for dynamic string resolution ([#96](https://github.com/niklam/iracedeck/issues/96)) ([700879d](https://github.com/niklam/iracedeck/commit/700879d93eba5108bcdb6c04482140978896f169))

### Bug Fixes

* **icons:** update fuel-service icon designs ([#88](https://github.com/niklam/iracedeck/issues/88)) ([ffc343f](https://github.com/niklam/iracedeck/commit/ffc343f0e9e7006fe161ba6aed610e1e4ccccd1d))

### Refactoring

* **icons:** complete icon extraction and cleanup unused utilities ([#87](https://github.com/niklam/iracedeck/issues/87)) ([31b5c7c](https://github.com/niklam/iracedeck/commit/31b5c7c4d11fb9e6c7d624bcf660c745039631d8))
* **icons:** extract dynamic action icons to @iracedeck/icons ([#86](https://github.com/niklam/iracedeck/issues/86)) ([f14acd7](https://github.com/niklam/iracedeck/commit/f14acd7e33f1fe40fd13cd9b6e7bf78cae9eb4f8))
* **icons:** extract icons to shared @iracedeck/icons package ([#84](https://github.com/niklam/iracedeck/issues/84)) ([3dc4f52](https://github.com/niklam/iracedeck/commit/3dc4f521b46cf4e35b79b6ae00d92c197c6d2047))
* **icons:** extract remaining static action icons to @iracedeck/icons ([#85](https://github.com/niklam/iracedeck/issues/85)) ([7d482b2](https://github.com/niklam/iracedeck/commit/7d482b2af5d1b011c5af0ca637b65824df7e3363))

### Documentation

* **website:** add download links, version requirement, and troubleshooting ([#83](https://github.com/niklam/iracedeck/issues/83)) ([d488cc0](https://github.com/niklam/iracedeck/commit/d488cc0b57a10de4afec16a956e24b0dbf9c188d))

### Maintenance

* **deps-dev:** bump @types/node from 24.0.15 to 25.3.3 ([#69](https://github.com/niklam/iracedeck/issues/69)) ([a9f47ae](https://github.com/niklam/iracedeck/commit/a9f47ae45d6649afaef781146c9d16fea7845a7b))
* **deps:** bump the minor-and-patch group across 1 directory with 6 updates ([#79](https://github.com/niklam/iracedeck/issues/79)) ([aaa253a](https://github.com/niklam/iracedeck/commit/aaa253a0c47e18ddb220e5450e1a6aa8c2280e2f))

## [0.10.1](https://github.com/niklam/iracedeck/compare/v0.10.0...v0.10.1) (2026-03-06)

### Bug Fixes

* **stream-deck-plugin:** show default sub-options on initial PI load ([#82](https://github.com/niklam/iracedeck/issues/82)) ([8043a28](https://github.com/niklam/iracedeck/commit/8043a285b05ca4e861bc9b337bdf0bad341bb680)), closes [#81](https://github.com/niklam/iracedeck/issues/81)

## [0.10.0](https://github.com/niklam/iracedeck/compare/v0.9.2...v0.10.0) (2026-03-06)

### Features

* **stream-deck-plugin:** add Setup Traction action ([#58](https://github.com/niklam/iracedeck/issues/58)) ([e90350f](https://github.com/niklam/iracedeck/commit/e90350feff4d1ff2542650a4066c032697705581)), closes [#25](https://github.com/niklam/iracedeck/issues/25)

### Documentation

* add release workflow documentation to README ([#78](https://github.com/niklam/iracedeck/issues/78)) ([71a2599](https://github.com/niklam/iracedeck/commit/71a2599617a24e28de5861c208861918400a21ee))

### Maintenance

* **ci:** delete .github/workflows/firebase-hosting-pull-request.yml ([5a505bb](https://github.com/niklam/iracedeck/commit/5a505bb16d7c15c73daa58e40cbc45e5eb123fcd))
* **deps-dev:** bump @rollup/plugin-commonjs from 28.0.9 to 29.0.0 ([#68](https://github.com/niklam/iracedeck/issues/68)) ([6751624](https://github.com/niklam/iracedeck/commit/67516241f47d45b6207e2bc48637a89c780b6674))
* **deps-dev:** bump firebase-tools from 13.35.1 to 15.8.0 ([#70](https://github.com/niklam/iracedeck/issues/70)) ([0f20c02](https://github.com/niklam/iracedeck/commit/0f20c021908c9bf4a7b97dea700c14d35f268f66))
* **deps-dev:** bump rimraf from 5.0.10 to 6.1.3 ([#67](https://github.com/niklam/iracedeck/issues/67)) ([a507339](https://github.com/niklam/iracedeck/commit/a5073396fef8dd04f807f9b12b255cf242596015))
* **deps:** bump actions/checkout from 4 to 6 ([#65](https://github.com/niklam/iracedeck/issues/65)) ([645bb2a](https://github.com/niklam/iracedeck/commit/645bb2a430de567a1ba2db10524cbcabc4d7477e))
* **deps:** pin all dependencies to exact versions ([#80](https://github.com/niklam/iracedeck/issues/80)) ([2059fed](https://github.com/niklam/iracedeck/commit/2059fedc96fcb6eb38731a05221891797fdc90df))

## [0.9.2](https://github.com/niklam/iracedeck/compare/v0.9.1...v0.9.2) (2026-03-05)

### Documentation

* add iRaceIT inspiration section to README ([aa9a083](https://github.com/niklam/iracedeck/commit/aa9a08344dd987c536861460fed47c466c649990))
* add PR template usage guidance to rules and agents ([#74](https://github.com/niklam/iracedeck/issues/74)) ([aa44471](https://github.com/niklam/iracedeck/commit/aa4447156ea41f498942f629d11a020cada93c8a))

### CI/CD

* add GitHub Actions CI workflows for pull requests ([#72](https://github.com/niklam/iracedeck/issues/72)) ([60fb872](https://github.com/niklam/iracedeck/commit/60fb8724c1b51cc946abe749f31c7d2759e4de18))

### Maintenance

* add cross-platform release wrapper for GITHUB_TOKEN ([9b45b5b](https://github.com/niklam/iracedeck/commit/9b45b5b6f4f62e7428fa6bb3d5f4c05d43e390ed))
* add pre-commit hooks with husky and lint-staged ([#75](https://github.com/niklam/iracedeck/issues/75)) ([537fa2b](https://github.com/niklam/iracedeck/commit/537fa2bb3f70efa6293d7022921d045c7d396593))
* add release workflow with release-it ([#77](https://github.com/niklam/iracedeck/issues/77)) ([9f97002](https://github.com/niklam/iracedeck/commit/9f970022285bc7347edce7ce8381075cd37f36e0))
* anchor dist/ and build/ gitignore patterns to repo root ([#76](https://github.com/niklam/iracedeck/issues/76)) ([24f2205](https://github.com/niklam/iracedeck/commit/24f2205f7fe5f3be4a7ae0edcb1a8c1f2a4b36f0))
