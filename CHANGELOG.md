# Changelog

## [0.13.0](https://github.com/niklam/iracedeck/compare/v0.12.0...v0.13.0) (2026-03-11)

### Features

* **website:** link to Elgato Marketplace instead of GitHub releases ([1dea507](https://github.com/niklam/iracedeck/commit/1dea50745d6ce10d4f73eb428528fe4347a8a97c))

### Maintenance

* add .sdignore, change build script to trim Stream Deck plugin ([#103](https://github.com/niklam/iracedeck/issues/103)) ([7f5ee0e](https://github.com/niklam/iracedeck/commit/7f5ee0ef9b4492b220594284388d5770568bca59))

## [0.12.0](https://github.com/niklam/iracedeck/compare/v0.11.0...v0.12.0) (2026-03-10)

### Features

* **iracing-sdk:** add lazy template context caching to SDKController ([2157126](https://github.com/niklam/iracedeck/commit/21571266d3e99c65ae3a5910363a2706917db24f))
* **iracing-sdk:** convert known 0/1 boolean telemetry fields to Yes/No ([4ec9673](https://github.com/niklam/iracedeck/commit/4ec9673f83c3eb14b4b02fdbbbc9b93ccb08d9a3))
* **stream-deck-plugin:** add Telemetry Display action with custom template support ([38f10da](https://github.com/niklam/iracedeck/commit/38f10da6404d60248f2edab63c01b4a3d1cc6525))
* **stream-deck-plugin:** support multiline templates in telemetry display ([3fc0121](https://github.com/niklam/iracedeck/commit/3fc01215c18a6bf2fba4967b3b4ac3723a830543))
* **stream-deck-plugin:** use number input for telemetry display font size ([28d85b7](https://github.com/niklam/iracedeck/commit/28d85b79da2466ca1a8f4a6d330921326cd051d5))
* **stream-deck-plugin:** use text color for telemetry display title ([cc40e6c](https://github.com/niklam/iracedeck/commit/cc40e6c66cd172240bbcdf996d4edc1e2d5db10a))
* **website:** add template variables reference page ([bc8e616](https://github.com/niklam/iracedeck/commit/bc8e616eb48a82d0aff1d01325c3a09f9d49a53f))

### Bug Fixes

* **icons:** change subLabel text color from [#aaaaaa](https://github.com/niklam/iracedeck/issues/aaaaaa) to [#ffffff](https://github.com/niklam/iracedeck/issues/ffffff) for readability ([e02e5c8](https://github.com/niklam/iracedeck/commit/e02e5c8e8943d00062fd9002f5b73485d898ec4c))
* **iracing-sdk:** flatten template context for correct dot-notation variable resolution ([aeec573](https://github.com/niklam/iracedeck/commit/aeec57323912da7b6525304e3d32a32325e0a1a9))
* **stream-deck-plugin:** adjust telemetry display text vertical position by font size ([06fc659](https://github.com/niklam/iracedeck/commit/06fc6593a2a50574fbc12e4d7ad87c24493b30de))
* **stream-deck-plugin:** apply defaults for sdpi-textfield and sdpi-textarea ([9ce9d03](https://github.com/niklam/iracedeck/commit/9ce9d03d5978fc5572ee11d28aa288281c621d65))
* **stream-deck-plugin:** fix PI template link URLs and font sizes ([0b7f856](https://github.com/niklam/iracedeck/commit/0b7f85645c8ee7f8609b7e18a4af7cb2b18f72e4))
* **stream-deck-plugin:** open PI links in new window with target="_blank" ([08ccfd8](https://github.com/niklam/iracedeck/commit/08ccfd86f8ead5caaef4294c32495cbf1712c605))
* **stream-deck-plugin:** unify PI template help text across actions ([02af3ce](https://github.com/niklam/iracedeck/commit/02af3ce04ad43c009ac0d0602524c2ce463712e7))
* **stream-deck-plugin:** update telemetry display defaults to CAR # template ([a478f2c](https://github.com/niklam/iracedeck/commit/a478f2cc7060f234cd816e7bba0887d380be570f))
* **website:** complete template variables reference with all session info fields ([4e71a14](https://github.com/niklam/iracedeck/commit/4e71a14452674b302f6bb7c364df085569ffff32))

### Refactoring

* **stream-deck-plugin:** simplify Telemetry Display Property Inspector ([eae354b](https://github.com/niklam/iracedeck/commit/eae354b56835e5942f1c7a087a160de3dbdb86b8))
* **stream-deck-plugin:** simplify Telemetry Display to custom template only ([c82636a](https://github.com/niklam/iracedeck/commit/c82636a0c0b3683209259cb2e3ae0a70d2139e86))

### Documentation

* mark all design doc progress items complete ([139d68b](https://github.com/niklam/iracedeck/commit/139d68bbd93bb4d54c436ecdaf09367ce11e4771))
* update Telemetry Display manifest and actions reference ([703e878](https://github.com/niklam/iracedeck/commit/703e878a08aabe8d1db6036f9eaefbe06e946ebc))

### Maintenance

* remove superseded template-variables.md and add design docs ([2fc4456](https://github.com/niklam/iracedeck/commit/2fc4456d84a3236da6c6f1b39cf028ee9f80881c))
* **website:** add Google Analytics tracking ([#97](https://github.com/niklam/iracedeck/issues/97)) ([bc0cd73](https://github.com/niklam/iracedeck/commit/bc0cd731d72c5d5d9bd1c142867ec3172aeb2687))
* **website:** update download links to v0.11.0 ([3b23c41](https://github.com/niklam/iracedeck/commit/3b23c41eb0f9519a30783737c61d87881f3673a2))

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
