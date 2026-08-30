# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] — 2026-08-30

### Added
- **Ad card in popup and manager.** A small ad slot appears at the bottom of the popup and
  the manager page. In this release it shows a house ad (static GitHub link, no network
  request). The code is architecture-ready for a network ad provider (EthicalAds), disabled
  by default — it fetches creative as JSON with `credentials: 'omit'` and renders with
  `textContent` only (MV3-safe, no script injection).
- 18 tests for the ad module (`test/ads.test.ts`): creative normalization, provider
  selection, house fallback, and network fetch behavior.

### Changed
- **License changed from MIT to PolyForm Noncommercial 1.0.0** for releases ≥ 0.3.0. Free
  for personal and noncommercial use; commercial use or redistribution requires the
  Licensor's permission. Releases ≤ 0.2.0 remain MIT.
- Privacy policy updated to disclose the ad card and the (disabled) network ad path.

## [0.2.0] — 2026-08-29

### Fixed
- **OPFS capability probe blocked every download on Chromium.** `detectCapabilities()` checked
  `createSyncAccessHandle` on the offscreen document's main thread, where the spec says it can
  never exist. The probe now recognizes this context and doesn't falsely reject; the writer
  worker remains the real capability gate.
- **Gzip/transport-compressed downloads failed.** `probe()` always sent `Range: bytes=0-0`;
  Chrome rejects ranged requests that return `200 + content-encoding: gzip`. Added a plain-GET
  fallback that detects compression and falls back to single-connection streaming.
- **HLS segments and keys now send `Accept-Encoding: identity`** to prevent silent corruption
  from transport compression on byte-range requests.
- **Bootstrap race dropped the first `engine:add`.** `ensureDocumentContext()` returned before
  the offscreen engine registered its message listener (~190ms window). Added a ping-gate with
  FIFO buffering — no command is lost during startup.

### Added
- E2E browser harness in `scripts/e2e/` (`npm run e2e`) — loads the unpacked extension into real
  Chromium, runs checklist items, verifies byte-exact files.
- `tsconfig.test.json` — tests and bench are now type-checked in CI.
- i18n: state labels and units now use `t()` instead of hardcoded Vietnamese.
- `docs/ROADMAP.md`, `docs/DESIGN.md`, `docs/SUPERPLAN.md`.
- 6 enhancement issues on GitHub.

### Changed
- UI polish: empty-state spacing, badge contrast in dark mode, consistent focus rings.
- `.gitignore`: added `*.pid`, `release/`, `.zcode/`.

## [0.1.0] — 2026-08-25

### Added
- Multi-connection HTTP Range download engine (8 connections, OPFS-backed).
- Manifest V3 extension for Chromium and Firefox, one codebase.
- HLS download support (playlist parsing, AES-128 decryption, segment assembly).
- Queue management with priority, pause/resume, retry, cancel.
- Speed limit, schedule windows, mirror search, adaptive connection count.
- 420 unit/integration tests, local test server, benchmark suite.
- Bilingual README (English + Vietnamese), ARCHITECTURE, PRIVACY, SECURITY, CONTRIBUTING docs.

[Unreleased]: https://github.com/baobao1044/down-faster/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/baobao1044/down-faster/releases/tag/v0.3.0
[0.2.0]: https://github.com/baobao1044/down-faster/releases/tag/v0.2.0
[0.1.0]: https://github.com/baobao1044/down-faster/releases/tag/v0.1.0
