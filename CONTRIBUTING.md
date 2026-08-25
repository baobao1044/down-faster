# Contributing to Down Faster

Down Faster is a multi-connection download accelerator packaged as a browser extension.
One TypeScript code base builds a Manifest V3 extension for both Chromium and Firefox.

This document tells you how to set the project up, what the conventions are, and — most
importantly — where the real gaps are. The project is honest about its state, and that
honesty is what makes it possible to contribute usefully.

---

## The most valuable contribution right now

**Nobody has ever run this extension in a real browser. Not once.** The development
machine has no browser installed. Everything the unit tests cannot reach has only ever
been reasoned about, never executed:

- OPFS and `createSyncAccessHandle()`
- Web Workers (`fetch-worker`, `writer-worker`) and `MessagePort` transfer
- The Chromium offscreen document
- `chrome.alarms`, `chrome.downloads`, `declarativeNetRequest`
- The content script that detects media in a page

So the single most useful thing you can do is: build it with `npm run build:dev`, load it
unpacked, work through the manual checklist in the README, and open an issue saying what
actually happened. Use `build:dev`, not `build`: a production build compiles every `log()`
call out of the bundle, so a failure that would have explained itself in the console
happens silently instead. See [Commands](#commands).

A report that reads *"checklist item 5 failed, here is the console output from
offscreen.html"* is worth more to this project than a feature PR. A report that reads
*"item 5 passed"* is worth almost as much, because it converts a paper claim into a
verified one.

The README carries a 21-item *Manual verification checklist* that exists precisely to
close this gap. Two of those items have no tooling behind them yet — see
[Known gaps that are easy to fix](#known-gaps-that-are-easy-to-fix).

---

## What is already verified

These claims were re-run while writing this document, and you can re-run them yourself:

| Claim | How to check |
|---|---|
| 397 tests pass, 0 fail, 0 skip, in about a second | `npm test` |
| Type checking is clean on both tsconfigs | `npm run typecheck` |
| Both targets build | `npm run build` |
| 141 i18n keys in `vi` and `en`; all 141 `vi` keys have a `description` | `npm test` |
| No telemetry anywhere in `src/` | see [No telemetry](#6-no-telemetry-no-runtime-dependencies) |

What the tests cover is real logic, not mocked stand-ins. The HLS AES-128 tests build
their fixtures with Node's actual `crypto.subtle.encrypt` and then make the engine
decrypt them. The benchmark imports the engine's real `planPieces()`,
`ConcurrencyController()` and `paceOptionsFor()` rather than copying their parameters,
so it cannot silently drift from the code that ships.

What the tests do **not** cover is described in
[Where the tests are not](#where-the-tests-are-not). Read that section before you
assume a green suite means a working download.

---

## Setup

You need **Node 20 or newer**. The build targets `node20` in esbuild, and the tests use
`node:test` plus global `fetch`. Development for this document was done on Node 22.

```bash
git clone https://github.com/baobao1044/down-faster.git
cd down-faster
npm install
npm run build
```

`npm install` pulls exactly three dev dependencies — `esbuild`, `typescript` and
`@types/chrome` — and zero runtime dependencies. Nothing from npm ends up inside the
shipped extension.

`npm run build` writes two unpacked extensions:

- `dist/chromium/`
- `dist/firefox/`

Load them like this:

- **Chromium**: `chrome://extensions` → enable Developer mode → *Load unpacked* → pick
  `dist/chromium`
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick
  `dist/firefox/manifest.json`

**If you want to see any logs, build with `npm run build:dev`.** A plain `npm run build`
sets `__DEV__=false`, and esbuild then folds every `log()` call out of the bundle: a
production build contains no `console.log` at all. Full explanation under
[Use `build:dev` when you are testing in a browser](#use-builddev-when-you-are-testing-in-a-browser).

Where to find the logs, which matters because the engine does not run where you would
expect:

- **Chromium**: `chrome://extensions` → *Details* → *Inspect views* → `offscreen.html`.
  The engine lives there, not in the service worker.
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Inspect*. The engine lives in
  the event page.

---

## Commands

Every command below is defined in `package.json` and works. Do not invent new ones in
documentation or in scripts without adding them here.

| Command | What it does |
|---|---|
| `npm run build` | Builds both targets into `dist/chromium` and `dist/firefox`; minified, logging compiled out |
| `npm run build:chromium` | Builds only the Chromium target |
| `npm run build:firefox` | Builds only the Firefox target |
| `npm run build:dev` | `node scripts/build.mjs --dev` — the same two targets, but sourcemaps kept, no minify, and **logging left in**. Use this to test in a browser |
| `npm run watch` | Rebuilds on change; implies `--dev`, so it behaves like `build:dev` |
| `npm test` | Bundles `test/*.test.ts` to ESM, runs them under `node --test` |
| `npm run typecheck` | `tsc --noEmit` against `tsconfig.json` *and* `tsconfig.worker.json` |
| `npm run testserver` | Local HTTP test server on `http://localhost:8787` |
| `npm run bench` | Throughput benchmark; needs the test server running first |
| `npm run verify <file>` | Byte-for-byte check of a file downloaded from the test server |
| `npm run make-icons` | Regenerates `src/icons/*.png` using Node's zlib, no image library |
| `npm run clean` | `rm -rf dist` |

### Use `build:dev` when you are testing in a browser

A dev build is produced by `--dev` or by `--watch`; it keeps inline sourcemaps and skips
minification. A plain `npm run build` is minified — and, more to the point, it defines
`__DEV__` as `false`. `src/shared/log.ts` guards `log()` behind that constant, so esbuild
resolves the branch at build time and drops the call sites entirely. Checked against the
bundles that `npm run build` produces: **zero `console.log`, and at most one
`console.warn` per bundle** — the i18n fallback. `fetch-worker.js`, `writer-worker.js` and
`media-detect.js` contain no console call of any kind.

There is also **no `console.error` in a production build, and none in a dev build either**.
`error()` is exported at `src/shared/log.ts:15`, but nothing in `src/` calls it. So never
ask a tester to look for `console.error` output, and never read a clean console as evidence
that a download went well — it is the expected state either way.

If you are loading the extension to test it:

```bash
npm run build:dev
```

Same `dist/chromium` and `dist/firefox` output directories, so nothing else in the load
instructions changes. Keep `npm run build` for anything you intend to ship.

---

## Repository layout

```
src/
  background/index.ts     Service worker (Chromium) / event page (Firefox).
                          The only place that calls downloads, notifications,
                          action, contextMenus, alarms, tabs and DNR, and the
                          engine's only route to storage.
  offscreen/              Chromium-only DOM context that hosts the engine.
  engine/
    manager.ts            Engine host: installEngineHost, dispatchEngineRequest
    orchestrator.ts       DownloadJob — one accelerated download, end to end
    pieces.ts             Range planning and the work-stealing queue
    probe.ts              One request to learn size / Range support / encoding
    policy.ts             Auto-mode decisions: take this download, or hand it back
    queue.ts schedule.ts  Concurrency cap, priority, time windows
    throttle.ts           One token bucket shared by the whole extension
    persistence.ts        Progress checkpoints
    recovery.ts           Resuming interrupted downloads after a restart
    storage.ts            OPFS temp files under a "parts" directory
    host.ts               HostBridge interface — the engine's only door out
    adaptive/             concurrency (AIMD), headers, mirrors, streaming
    hls/                  playlist parser, AES-128 keys, segment assembly
    workers/              fetch-worker.ts, writer-worker.ts
  platform/               Chromium vs Firefox differences, capability detection
  shared/                 i18n, settings, protocol, rpc, log
  ui/                     popup, manager page, welcome page, a11y, formatting
  content/media-detect.ts Content script that spots media URLs in a page

test/                     8 files, 397 tests, node:test
bench/bench.ts            Throughput benchmark, imports the real engine functions
scripts/                  build.mjs, test.mjs, bench.mjs, testserver.mjs,
                          verify.mjs, make-icons.mjs
manifest/                 base.json plus a chromium.json and firefox.json overlay
_locales/                 vi (default) and en
```

Roughly 13,393 lines of TypeScript in `src/` across 40 files, and 5,467 lines in `test/`.

### Architecture in one paragraph

Speed comes from opening several HTTP connections at once, each asking for a different
byte range with a `Range` header, all writing into one file on disk. The engine cannot
live in the MV3 service worker: that context has no DOM, cannot spawn a `Worker`, and
cannot create a blob URL. On Chromium the engine therefore runs in an offscreen
document; on Firefox the event page already has a DOM, so it runs there. Because an
offscreen document is only guaranteed access to `chrome.runtime`, the engine never calls
a browser API itself — it asks through `HostBridge` and the background page does the
work. Bytes are written through OPFS `createSyncAccessHandle()`, which takes an exclusive
lock, so exactly one writer worker exists and the fetch workers hand it buffers over a
`MessagePort` using transfer.

---

## The test server and the benchmark

### Test server

```bash
npm run testserver          # http://localhost:8787
npm run testserver -- --port=8912
```

The server generates its bytes from `byte[i] = i % 251` instead of reading a file. 251 is
prime, so any piece written at the wrong offset — or two pieces overlapping — shows up
immediately:

```bash
npm run verify ~/Downloads/some-file.bin
```

Endpoints, each aimed at one branch of the engine:

| Endpoint | Exercises |
|---|---|
| `/file/<bytes>` | Normal path, full `Range` support |
| `/slow/<bytes>?kbps=200` | Throttles each connection **separately** |
| `/norange/<bytes>` | Ignores `Range`; engine must fall back to one connection |
| `/gzip/<bytes>` | Sends `Content-Encoding: gzip`; engine must disable splitting |
| `/named/<bytes>` | RFC 5987 `Content-Disposition` with a Vietnamese filename |
| `/flaky/<bytes>?drop=1048576` | Drops mid-transfer; exercises the retry path |
| `/stats` | Returns `{active, peak, totalRequests}` — connection counts only |

### Benchmark

The benchmark needs the server running in another terminal:

```bash
npm run testserver                          # terminal 1
npm run bench                               # terminal 2, defaults to :8787
npm run bench -- http://localhost:8912      # or point it somewhere else
```

Six runs on the development machine, 2026-08-25. These are the figures README.md,
README.vi.md and ARCHITECTURE.md quote, so the four documents cannot drift apart:

```
4 MiB, each connection throttled to 500 KB/s
  1 connection    8.22 - 8.26 s
  accelerated     2.03 - 2.04 s   peak 4 connections
                                  ->  4.0x faster
32 MiB, each connection throttled to 2000 KB/s
  1 connection   16.65 - 16.74 s
  accelerated     2.05 - 2.07 s   peak 8 connections
                                  ->  8.1x faster
```

Quote the range, never a single figure. The speedup ratio came out identical in all six
runs; the raw seconds moved by about 1% between them, which is exactly the width shown
above. A number like `8.25s` claims a precision this measurement does not have, and four
documents each rounding their own copy of one run is how they end up quoting four
different values for the same benchmark. All six runs were checked with `npm run verify`
and all six came back byte-exact.

`bench/bench.ts` sizes these cases as `4 * 1024 * 1024` and `32 * 1024 * 1024`, so they
are MiB. Its console labels still read `4 MB` and `32 MB`; the sizes are right, the unit
strings are not.

**Read the methodology before quoting these numbers.**

- The test server throttles **each connection separately**. Parallel connections only
  help when the server is the bottleneck. If the bottleneck is your own link, splitting
  it into eight streams changes nothing. That is physics, not a tuning problem.
- The 4 MiB case reaches 4.0x, not 8x, and this is structural, not noise. `planPieces()`
  enforces a 1 MiB minimum piece (`MIN_PIECE` in `src/engine/pieces.ts`), so a 4 MiB file
  yields exactly 4 pieces. `paceOptionsFor()` in `src/engine/orchestrator.ts` then caps
  concurrency at `min(connections, pieceCount)`. Speedup is bounded by piece count, and
  piece count is bounded by file size: up to 32 MiB a file is cut into
  `ceil(size / 1 MiB)` pieces, so it takes more than 7 MiB before all 8 connections have
  work, and a file under 2 MiB (`MIN_MULTI_SIZE`) is never split at all.
- The benchmark replaces the fetch worker with a Node loop and OPFS with a `Buffer`. It
  proves the piece planner, the work-stealing queue and the AIMD controller. It does
  **not** touch the writer worker, `MessagePort` transfer, write-ack backpressure, OPFS,
  retries, mirrors, HLS, persistence, or `DownloadJob`. It also never imports
  `throttle.ts`, so the shared token bucket has never been measured.
- It runs over loopback: no TLS, no packet loss, no DNS, no real CDN. Treat the numbers
  as an ideal upper bound, not an expectation.
- Six runs per configuration, all on the same machine, all byte-verified. That buys
  repeatability on one machine over loopback — it is not a claim about your hardware,
  your link, or a server you do not control.

Never publish a speed number from this project without the methodology attached.

### Why the benchmark exists

It caught a real regression in the author's own code, which is the argument for keeping
it. The AIMD prober originally started at 2 connections and climbed one step every ~4
seconds, so it took about 24 seconds to reach a ceiling of 8 — longer than most
downloads. Measured cost: 93% slower on a 4 MiB file, 210% slower on 32 MiB. The fix was
to open straight at the user's configured ceiling and let AIMD act only as a brake when
the server returns 429/503 or a `Retry-After`. After the fix, adaptive matches a hard
ceiling within 0–5%. `paceOptionsFor()` now returns `start: max`, and four tests in
`test/integration.test.ts` lock that in.

That old slow branch has been deleted, so `npm run bench` cannot reproduce the "before"
number today. If you cite it, say it was measured before the fix.

---

## Project conventions

### 1. Comments are in Vietnamese, and they explain *why*

Every `//` comment in `src/` is written in Vietnamese with full diacritics. The only
exceptions are the two `/// <reference lib="webworker" />` directives. Never write
Vietnamese without diacritics in `src/`.

More important than the language: a comment must explain **why**, not **what**. The code
already says what it does. Comments that restate it are noise; comments that record the
constraint or the failed alternative are the reason the next person does not undo your
fix. Real examples, with paths so you can check them (`[…]` marks an elision):

```ts
// src/engine/throttle.ts
/**
 * […] Cố tình KHÔNG dùng SharedArrayBuffer +
 * Atomics.wait: chặn vòng lặp message của fetch worker sẽ khóa chết luôn đường
 * nhận WriteAck từ writer, mà van điều áp của worker lại đang phụ thuộc vào đó.
 */
```

```ts
// src/engine/workers/writer-worker.ts
// Biên nhận là van điều áp của fetch worker. Nó phải trả về đúng số byte đã
// nhận trong mọi nhánh, kể cả nhánh lỗi, nếu không bên kia sẽ chờ mãi.
```

```ts
// src/shared/i18n.ts
/**
 * […] Token `{ten}` đi qua `getMessage` nguyên
 *    vẹn vì chrome.i18n chỉ để ý ký tự `$`. Đổi lại, messages.json tuyệt đối
 *    không được chứa ký tự `$` — test canh chỗ đó.
 */
```

If you delete a comment like that, you are deleting the only record of a bug someone
already paid for.

Scripts under `scripts/` currently use unaccented Vietnamese. That is existing
inconsistency, not a second convention — new comments there should use diacritics too.

### 2. Every user-facing string goes through `_locales`

No string a user can see may be written inline. Add the key to **both**
`_locales/vi/messages.json` and `_locales/en/messages.json`, then read it with `t()` from
`src/shared/i18n.ts`, or declaratively with `data-i18n` in HTML.

Every Vietnamese entry **must** carry a non-empty `description`. This is enforced by a
test, so a missing description fails `npm test`:

```json
"ext_description": {
  "message": "Tăng tốc tải file bằng nhiều kết nối song song, ngay trong trình duyệt.",
  "description": "Mô tả ngắn trong manifest và trên cửa hàng extension."
}
```

The `description` field is for translators and is not required on the English side.

`test/i18n.test.ts` also enforces, and will fail your PR over:

- key parity between `vi` and `en` in both directions
- key shape `^[a-z][a-z0-9_]*$`
- no two keys that collide once lowercased, because Chrome lowercases on lookup
- identical `{token}` sets across both languages
- **no `$` character in any message** — `chrome.i18n` treats `$` as substitution syntax
  and will silently eat the surrounding text in a real build while every other test
  stays green
- every key literal typed in `src/` actually exists in `_locales/vi`
- every `DownloadState` in `src/engine/types.ts` has a matching `state_*` string, so
  adding an engine state without a label is caught rather than read aloud to a screen
  reader as an English identifier

Parameters use `{name}` tokens substituted by our own `format()`, **not** the
`placeholders` block of `chrome.i18n`. The reason is documented at the top of
`src/shared/i18n.ts`: calling `getMessage(key)` without substitutions wipes every
declared `$NAME$`, so the string cannot be fetched first and filled in later.

### 3. Worker code obeys `tsconfig.worker.json`

`src/engine/workers/` is compiled under a **different** tsconfig from the rest of `src/`:

- `tsconfig.json` — `lib: ["ES2022", "DOM", "DOM.Iterable"]`, `types: ["chrome"]`,
  includes `src/**/*.ts` but **excludes** `src/engine/workers/**`
- `tsconfig.worker.json` — `lib: ["ES2022", "WebWorker"]`, `types: []`, and includes only
  `src/engine/workers/**`, `src/shared/protocol.ts`, `src/engine/types.ts`,
  `src/engine/throttle.ts`

That include list is the contract. A worker has no DOM and no `chrome` namespace, so
importing a module that touches either will fail `npm run typecheck` on the second
config even though the first one passes. This is exactly why `npm run typecheck` runs
both, and why you must run it rather than trusting your editor, which usually only picks
up the first config.

If a worker genuinely needs a new shared module, add that module to the `include` list of
`tsconfig.worker.json` in the same PR and make sure it stays DOM-free.

### 4. The engine never calls a browser API directly

`src/engine/host.ts` defines `HostBridge`. Inside `src/engine/`, everything that touches
`downloads`, `storage`, `notifications`, `action` or `declarativeNetRequest` goes through
it, and `src/background/index.ts` is the only place that actually performs those calls.
The rule is about the engine, not the whole code base: `src/shared/settings.ts` and the
content script read `storage.local` directly, because neither ever runs offscreen.

This is not layering for its own sake. A Chromium offscreen document is only guaranteed
`chrome.runtime`; calling `chrome.storage` from the engine would work on Firefox and fail
on Chromium, which is the worst possible failure shape. Two engine modules do import
`platform/api` — `manager.ts` and `orchestrator.ts` — but only for `runtime`
(`sendMessage`, `onMessage`, `getURL`), which is exactly what an offscreen document is
guaranteed. Anything beyond `runtime` belongs behind a new `HostBridge` method.

One related trap: on Firefox, `runtime.sendMessage` does not deliver to the sending
context. That is handled by calling `dispatchEngineRequest()` directly instead of going
through messaging. This path has never been exercised on a real Firefox.

### 5. Manifests are a base plus a hard overlay

`manifest/base.json` is merged with `manifest/chromium.json` or `manifest/firefox.json`
at build time, and the version comes from `package.json`. **The overlay replaces keys
outright — arrays are not merged.** So `manifest/chromium.json` has to repeat the entire
`permissions` array just to add `"offscreen"`. If you add a permission to the base, check
whether the Chromium overlay needs the same edit.

### 6. No telemetry, no runtime dependencies

There are exactly **11** request sites in `src/`. Ten target a URL the user supplied:
`probe.ts` (2), `workers/fetch-worker.ts`, `orchestrator.ts` (reading a byte range to
fingerprint a mirror), `adaptive/streaming.ts` (3 — the single-stream path, its size
probe, its resume check), `hls/index.ts` (2), and `hls/keys.ts`. The eleventh,
`i18n.ts:303`, fetches `runtime.getURL('_locales/<locale>/messages.json')` — an internal
extension resource that never leaves the browser.

Use this grep, not a bare `fetch(` one:

```bash
grep -rnE '\bfetch\(|fetchImpl\(' src/ --include='*.ts'
```

Thirteen lines: eleven request sites plus two that are not requests — a comment in
`adaptive/headers.ts:264` that happens to mention `fetch()`, and the wrapper definition
at `adaptive/streaming.ts:151`. The `fetchImpl(` half is required because
`streaming.ts` takes its `fetch` as an injectable dependency so tests can substitute one;
without it the grep silently misses three real call sites, which is how an earlier
revision of this file arrived at nine. There is no `XMLHttpRequest`, no `WebSocket`, no
`sendBeacon`, no `new Image()`.

Replay headers (`Referer`, `Cookie`) live in RAM only, with a TTL, and are never written
to `chrome.storage` — see the `HeaderStore` class in `src/engine/adaptive/headers.ts`.

A PR that adds an analytics endpoint, a crash reporter, or a runtime npm dependency will
be declined. Keep both of those numbers where they are.

### 7. Code style

TypeScript is `strict` with `noUncheckedIndexedAccess`, `noImplicitOverride`,
`verbatimModuleSyntax` and `isolatedModules`. Note that `skipLibCheck` is on and
`exactOptionalPropertyTypes` is off, so do not describe the setup as maximally strict.

There is no linter and no formatter in the repo. Match the surrounding file: 2-space
indent, single quotes, semicolons, trailing commas in multi-line literals, and lines
around 90 characters.

---

## Where the tests are not

397 passing tests do not mean a working download, and the project would rather say so
than let you find out the hard way.

**15 of the 40 files in `src/` — 3,154 lines — are not touched by any test at all, not
even indirectly through another module's imports:**

```
src/engine/manager.ts                 src/engine/workers/writer-worker.ts
src/ui/manager.ts                     src/offscreen/offscreen.ts
src/background/index.ts               src/shared/protocol.ts
src/content/media-detect.ts           src/platform/capabilities.ts  (see below)
src/engine/workers/fetch-worker.ts    src/ui/format.ts
src/ui/dom.ts                         src/engine/host.ts
src/ui/popup.ts                       src/ui/welcome.ts
src/shared/rpc.ts
```

Reachability here comes from esbuild's metafile for the test bundle, so a file counts as
covered even if no test imports it by name. An earlier revision of this section said *18
files, 3,288 lines, imported by no test at all* — that was a count of **direct** imports
worded as though it meant "no test ever runs this code", which was wrong for
`src/engine/storage.ts`, `src/platform/api.ts` and `src/shared/log.ts`. All three are
pulled in transitively and do execute during `npm test`. Not tested in its own right and
never executed are different claims; this list is the second one.

`src/platform/capabilities.ts` is the one partial case, and it is worth stating precisely.
Four tests in `test/integration.test.ts` now cover `requireStorage()`, the gate
`DownloadJob.openWriter()` calls before it commits to a write strategy — missing OPFS or a
missing `createSyncAccessHandle` fails fast there instead of halfway through a download.
`detectCapabilities()`, the function that does the actual probing, has still never been
executed by a test and cannot be until someone runs it in a browser.

**Worse, the two largest classes in the project sit inside files that *are* imported by
tests, yet are themselves untested:**

- `DownloadJob` — `src/engine/orchestrator.ts:153-967`, 815 lines.
  `test/integration.test.ts` imports only two pure functions from that file,
  `failureKind` and `paceOptionsFor`.
- `HlsJob` — `src/engine/hls/index.ts:518-1091`, 574 lines. `test/hls.test.ts`
  imports only `classifyMediaUrl` and `buildSegmentRequests` from that 1,188-line file.

Together that is 4,543 lines, about 34% of `src/`. Stated plainly: **the pieces are
tested thoroughly; the thing that joins them into an actual download is not.**

Two more things worth knowing:

- `test/integration.test.ts` is misleadingly named. Sixteen of its 20 tests are assertions
  on pure functions; the other four drive `requireStorage()` with an injected probe.
  Nothing is wired to a browser, a worker or a real file. Do not cite it as evidence of
  integration coverage.
- Neither tsconfig includes `test/` or `bench/`, and `scripts/test.mjs` uses esbuild,
  which strips types without checking them. So those 5,467 lines of test code, plus the
  163 lines of `bench/bench.ts` — 5,630 lines in total — have never been type-checked.

`DownloadJob` and `HlsJob` are the important detail here, and the honest version is that
they are **partly reachable today**. `DownloadJob` already takes a `JobDeps` seam for the
throttle port, the header port and a resume seed, and `test/persistence.test.ts` shows
the pattern with its in-memory `PersistenceStore`. But both classes import
`src/engine/storage.ts` statically and build real `Worker`s from `runtimeUrl(...)`, so
covering the write path means stubbing OPFS and `Worker`, or widening the seam first.
That refactor plus the tests is the highest-value code contribution available.

---

## Good first contributions

Ranked by usefulness to the project, not by difficulty:

1. **Run it in a real browser** and report back against the README's 21-item checklist.
   Nothing else on this list changes as much.
2. **Test `DownloadJob`** with injected fakes, following `test/persistence.test.ts`. The
   `JobDeps` seam already covers the throttle and header ports; OPFS and `Worker` still
   need stubs. Start with the hand-back paths, since those are where a bug costs a user
   their file.
3. **Test `HlsJob`** the same way.
4. **Test the glue**: `src/shared/rpc.ts`, `src/engine/host.ts` consumers,
   `src/ui/format.ts`. Small files, quick wins, real coverage.
5. **Add `test/` and `bench/` to a tsconfig** so that test code is type-checked too.
6. **Fix the two broken manual checks** described below.

### Known gaps that are easy to fix

Two entries in the README's manual checklist are flagged in the README itself as having
no tooling behind them. Building that tooling is a small, self-contained contribution:

- **Item 14** wants confirmation that the speed limit applies across the whole extension
  rather than per connection. `/stats` cannot show this — it returns only
  `{active, peak, totalRequests}`, with no byte counts and no rate. Adding a byte counter
  to `scripts/testserver.mjs` would make the check mechanical instead of a stopwatch job.
- **Item 17** wants a download of unknown size. `scripts/testserver.mjs` sets
  `content-length` on every route, including `/norange`, and has no chunked endpoint. The
  streaming path in `src/engine/adaptive/streaming.ts` has 18 unit tests but currently no
  way to be exercised by hand. A `Transfer-Encoding: chunked` endpoint would fix that.

Also note that the shared token bucket in `src/engine/throttle.ts` has unit tests but has
never been measured end to end — the benchmark does not import it.

---

## Before you open a pull request

Run all three. All three must be green:

```bash
npm run typecheck && npm test && npm run build
```

`npm run typecheck` covers both tsconfigs; do not substitute your editor's diagnostics,
which usually only see the first one.

Then check the following:

- [ ] Any user-facing string is in `_locales/vi` **and** `_locales/en`, and the
      Vietnamese entry has a non-empty `description`.
- [ ] No `$` character in any message string.
- [ ] New comments are in Vietnamese with diacritics, and explain *why*.
- [ ] Nothing in `src/engine/` calls a browser API directly — it goes through
      `HostBridge`.
- [ ] Worker code still type-checks under `tsconfig.worker.json`; any new shared import
      was added to that file's `include` list.
- [ ] A permission added to `manifest/base.json` was also added to
      `manifest/chromium.json` if needed, because the overlay replaces arrays.
- [ ] No new runtime dependency and no new network destination.
- [ ] New behaviour has a test, unless it genuinely requires a browser — and if it does,
      say so in the PR description rather than leaving it implied.
- [ ] Any speed number you quote carries its methodology and the caveat that parallel
      connections only help when the server throttles per connection.
- [ ] User-facing documentation changes land in **both** `README.md` (English) and
      `README.vi.md` (Vietnamese).

Keep the branch focused on one change, and branch off the default branch.

CI (`.github/workflows/ci.yml`) runs four steps — `npm run typecheck`, `npm test`,
`npm run build:dev`, then `npm run build` — on Node 20 and Node 22 on
pushes to `main` or `master` and on pull requests targeting them, so running them locally
first just saves you a round trip. Pushing a feature branch does not trigger it; opening
the pull request does.
A second job runs the benchmark, but it is marked `continue-on-error` and can never turn
CI red: GitHub runners are shared hardware, so the seconds it reports track whoever else
is on the machine rather than your change. That job exists to catch the benchmark
*breaking* — it imports the engine's real functions, so a changed signature or a hang
shows up there — not to gate performance. Speed numbers published anywhere in this
repository are measured on a development machine, never taken from CI.

The workflow itself is untested in the same sense the extension is: it says so in its own
header comment. Every step was run by hand on Node 22, but the file has never executed on
GitHub Actions, and the Node 20 leg of the matrix has never run anywhere. Expect to fix
something on the first green-or-red run.

---

## Reporting a bug

Open an issue at
[github.com/baobao1044/down-faster/issues](https://github.com/baobao1044/down-faster/issues)
and include:

- browser and version, and whether you loaded `dist/chromium` or `dist/firefox`
- which README checklist item, or which URL, triggered it
- console output from the context where the engine runs — `offscreen.html` on Chromium,
  the event page on Firefox, **not** the service worker. Build with `npm run build:dev`
  first or there will be nothing to copy: a production build carries no `console.log`, and
  no build of any kind carries a `console.error`, so an empty console is the normal state
  and tells neither of us anything
- whether `npm run verify` reported the downloaded file as byte-correct, if a file was
  produced at all

Since the extension has never run in a browser, "it did not work at all" is a completely
valid and useful report. Please do file it.

---

## Things this project will not do

Stated up front so nobody spends a weekend on a PR that cannot be merged:

- **BitTorrent.** Browsers cannot open a TCP socket, and WASM does not change that.
  WebTorrent only speaks to WebRTC peers, so in practice it finds no seeders. It is a
  hard boundary against aria2 or Motrix, though not the only one: being native programs
  they also do FTP/SFTP, Metalink, headless and RPC operation, and downloads that survive
  the browser closing — none of which is reachable here. What this has and they do not is
  the user's live session, which is what lets it fetch a file behind a login.
- **Speeding up a connection that is already saturated.** Multiple connections help only
  when the server limits each connection. If your own link is the bottleneck, there is
  nothing to win.

Current known limitations, all of which *are* open to contributions:

- HLS concatenates segments but does not remux. Separate video and audio tracks cannot be
  merged into one file yet. DASH URLs are only recognised, not downloaded.
- A file exists twice on disk briefly: the OPFS temp copy and the final one.
- The Chromium service worker bundle is 118 KB (118,084 bytes) because `installEngineHost` is imported
  statically for Firefox's benefit, even though the Chromium branch does not use it.
  Wasteful, not incorrect.
- On Firefox MV3 `host_permissions` are optional and must be granted by the user; there
  is no permission-request screen yet.

---

## License

MIT. By contributing you agree that your contribution is licensed under the same terms.

Maintainer: BaoBG (<baobg104@gmail.com>).
