# Down Faster

A browser extension that downloads a file over several parallel HTTP range requests
instead of one. Chromium and Firefox, Manifest V3, one code base, no external binary,
no companion app.

[![CI](https://github.com/baobao1044/down-faster/actions/workflows/ci.yml/badge.svg)](https://github.com/baobao1044/down-faster/actions/workflows/ci.yml)

`license: MIT` · `status: alpha — never run in a real browser` · `397 tests passing`

*The badge is real and it is narrow. On the first commit GitHub Actions ran the suite on
a clean `npm ci` under both Node 20 and Node 22, and both legs went green, so "397 tests
passing" is no longer only the author's word. What the badge does **not** cover is the
part that matters most: Actions runs headless Linux with no browser, exactly like the
development machine, so it exercises the same pure logic and leaves every
browser-dependent path untouched. A green tick here means the code compiles and the unit
tests pass. It is not evidence that the extension works.*

> [!WARNING]
> **This extension has never been run in a real browser. Not once.** The development
> machine has no browser installed, so every browser-dependent path is correct on paper
> and in unit tests only — never observed working: OPFS and `createSyncAccessHandle`,
> Web Workers, the offscreen document, `chrome.alarms`, `declarativeNetRequest`,
> `chrome.downloads`, and the content script.
>
> The pure logic has 397 passing tests, but the code that wires those tested pieces into
> an actual download — `DownloadJob` (815 lines) and `HlsJob` (574 lines) — has no tests
> either. Roughly 34% of `src/` is untested. Nobody but the author has ever run it, and
> it is not on any extension store.
>
> **Auto mode and page scanning are both on by default** — `autoMode: true` *and*
> `detectMedia: true` in `src/shared/settings.ts`. From the moment the extension is
> loaded it takes over every download above 5 MiB without being asked, and its content
> script runs on every page you open, in every frame, looking for `<video>` tags and
> `.m3u8` URLs. The code that does the taking over is in the untested 34%. Both are
> switches, not fixed behaviour: turn off **Automatic speed-up** on the manager page or
> in the popup to leave downloads to the browser, and **Settings → Find video on pages**
> to stop the page scanning. Do that before browsing normally.
>
> **Do not use this for anything that matters.** Treat it as a design and a test suite
> that happens to compile into two loadable extensions.

---

## What it is for

A browser downloads a file over one HTTP connection. Many servers cap throughput
*per connection* rather than per client. When that is the case, opening eight
connections and asking each for a different byte range with a `Range` header finishes
the same file several times faster.

That is the whole trick, and it is old. The interesting part is that Manifest V3 makes
it awkward to implement inside an extension, and most of this code base exists to get
around those constraints rather than to do the downloading.

## How it is put together

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ content script      detects <video> and .m3u8 URLs in the page       │
 └───────────────┬──────────────────────────────────────────────────────┘
                 │ runtime.sendMessage
 ┌───────────────▼──────────────────────────────────────────────────────┐
 │ background      service worker (Chromium) · event page (Firefox)     │
 │ the only context allowed to touch downloads / storage / alarms /     │
 │ notifications / action / declarativeNetRequest                       │
 └───────────────┬──────────────────────────────────────────────────────┘
                 │ HostBridge — the engine never calls a browser API itself
 ┌───────────────▼──────────────────────────────────────────────────────┐
 │ engine host     offscreen document (Chromium) · same page (Firefox)  │
 │ queue · shared token bucket · piece table · progress checkpoints     │
 └──────┬─────────────────────────────────────────────┬─────────────────┘
        │ spawns N                                    │ spawns exactly 1
 ┌──────▼──────────────────┐   MessagePort      ┌─────▼──────────────────┐
 │ fetch worker × N        │  buffer moved,     │ writer worker × 1      │
 │ Range: bytes=A-B        │──not copied───────>│ createSyncAccessHandle │
 │ waits for write-ack     │<──write-ack────────│ → OPFS, random access  │
 └─────────────────────────┘  (backpressure)    └─────┬──────────────────┘
                                                      │ blob URL
                                       downloads.download() → user's disk
```

**The engine cannot live in the service worker.** An MV3 service worker has no DOM,
cannot spawn a `Worker`, cannot create a blob URL, and is killed when idle. On Chromium
the engine runs in an offscreen document; on Firefox the event page already has a DOM,
so it runs there directly.

**The offscreen document can only rely on `chrome.runtime`.** Everything touching
`downloads`, `storage`, `notifications`, `action` or `declarativeNetRequest` is
delegated to the background page through `HostBridge` (`src/engine/host.ts`). The engine
requests; whoever holds the permission performs.

**Bytes go to OPFS, not to RAM.** Concatenating chunks in memory dies at a few GB.
`createSyncAccessHandle()` writes at arbitrary offsets straight to disk. That handle
takes an exclusive lock, so there is exactly one writer worker, and the fetch workers
hand their buffers over a `MessagePort` as transfers rather than copies.

**Nothing starts until OPFS is confirmed present.** `DownloadJob.openWriter()` — the one
place every download path reaches the disk through — awaits `requireStorage()`
(`src/platform/capabilities.ts`) before it spawns the writer. A browser with no OPFS, or
with OPFS but no `createSyncAccessHandle`, fails right there, with a sentence naming what
is missing, instead of several steps later inside a worker. In auto mode that is the
difference that matters: failing this early still leaves `fail()` able to hand the
original URL back to the browser, so the file is not lost. The probe runs once per
session and the answer is cached. This is not a hypothetical case — some browsers do not
expose OPFS in private windows.

**Pieces are smaller and more numerous than connections** — four per connection,
1 MiB minimum (`src/engine/pieces.ts`). Splitting a file statically into N equal parts
breaks the moment one connection lands on a slow CDN node: the other seven finish and
sit idle. Idle workers steal the next pending piece instead.

**There is backpressure.** The network is usually faster than the disk, so a fetch
worker waits for a write acknowledgement from the writer before reading more.

**AIMD is a brake, not an accelerator.** A download opens straight at the user's
configured ceiling; the controller only pulls it down on 429/503 or `Retry-After`, then
eases back up. It used to work the other way around, which cost a lot — see below.

**One token bucket for the whole extension.** "500 KB/s" means the extension, not each
connection. The bucket lives in the engine host and hands out grants to workers
(`src/engine/throttle.ts`).

**A mirror must prove it is the same file.** Two URLs the user believes are identical
but are not would produce a silently corrupt file. A secondary source only joins the
pool after a strong ETag match, or after three 64 KiB sample windows (head, middle,
tail) hash the same.

**Secrets never reach disk.** The replay store for `Referer` and `Cookie` is an
in-memory `Map` with a TTL and an LRU cap (`HeaderStore` in
`src/engine/adaptive/headers.ts`); it is never written to `chrome.storage`. Headers that
`fetch()` refuses to set are installed as per-download `declarativeNetRequest` session
rules and removed when the download ends.

## Measured numbers

These come from six `npm run bench` runs on the author's development machine on
2026-08-25. **Read the method before the numbers.**

**Method.** A local test server (`scripts/testserver.mjs`) throttles **each connection
separately** — that is the one condition under which multiple connections help at all.
The benchmark (`bench/bench.ts`) imports the engine's real `planPieces()`,
`remainingRange()`, `takeNextPending()`, `ConcurrencyController()` and
`paceOptionsFor()`; it substitutes a Node loop for the fetch worker and a `Buffer` for
OPFS. Every run verifies every byte against `byte[i] = i % 251`; all six runs reported
byte-exact output.

| File / per-connection cap | 1 connection | up to 8 allowed | peak actually used | speedup |
|---|---|---|---|---|
| 32 MiB @ 2000 KB/s | 16.65–16.74 s | 2.05–2.07 s | 8 | **8.1×** |
| 4 MiB @ 500 KB/s | 8.22–8.26 s | 2.03–2.04 s | 4 | **4.0×** |

**Reproduced on a second machine.** The benchmark job in CI ran the same thing on a
GitHub-hosted runner and landed on 4.0x and 8.0x — the 32 MiB case came out one tenth
below the local 8.1x, which is what a noisy shared runner looks like. Ratios reproducing
across two unrelated machines is the strongest thing that can be said for these numbers,
and it is still a statement about one throttled test server, not about the internet.

**Six runs, one machine, ranges on purpose.** The speedup ratios came out identical in
all six runs; the raw times moved by about 1% between them, which is why the table gives
a range instead of a single figure. Quoting one run to two decimals — `8.25s` — would
claim a precision this measurement does not have, and it is exactly how four documents
end up with four different numbers for the same measurement. ARCHITECTURE.md,
CONTRIBUTING.md and README.vi.md quote these same ranges, so the four documents cannot
drift apart.

**Multiple connections only help when the server caps throughput per connection.** If
the bottleneck is your own link, splitting it into eight streams changes nothing. That
is physics, not a tuning problem.

### Why the 4 MiB file only reaches 4.0×, not 8×

`planPieces()` never cuts a piece below 1 MiB, so a 4 MiB file yields exactly four
pieces. `paceOptionsFor()` then clamps the connection ceiling to the piece count:

```ts
const max = Math.max(1, Math.min(options.connections, pieceCount || 1));
return { min: …, max, start: max };
```

Four pieces means four usable connections, regardless of the user's setting of 8. The
benchmark confirms it, printing `peak 4 connections` and a flat ramp of `4 4 4 4`.

**Speedup is bounded by piece count, and piece count is bounded by file size.** At the
default of 8 connections the pieces stay at the 1 MiB floor, so a file has to exceed
7 MiB before an eighth piece exists at all — called directly with `connections: 8`,
`planPieces()` still returns seven pieces at exactly 7 MiB and an eighth only at
7,340,033 bytes, one byte over. Below that, eight connections are unreachable no matter
what the user sets. Smaller file, smaller gain. An earlier version of this README claimed
8.4× for a 4 MiB file; that number came from eight manual `curl` requests, not from the
engine, and the engine cannot structurally produce it. It has been removed.

### What the benchmark does *not* prove

It exercises the piece planner, the work-stealing queue and the concurrency controller.
It does **not** touch the writer worker, `MessagePort` transfers, write-acks, OPFS,
retry, mirrors, HLS, persistence, `DownloadJob`, or `throttle.ts` — the shared token
bucket has never been measured. It runs over loopback: no RTT, no TLS, no packet loss,
no DNS, no real CDN. Six runs per configuration, spread about 1%, on one machine — that
says nothing about a second machine. Treat these as an ideal upper bound, not an
expectation.

### A regression the benchmark caught

The concurrency probe originally started at 2 connections and climbed one step only
after two measurement windows — `windowMs: 2000` plus one `settleWindows` pause in
`DEFAULT_CONCURRENCY` (`src/engine/adaptive/concurrency.ts`), so about 4 seconds per
step and roughly 24 seconds to reach a ceiling of 8, longer than most downloads last.
Measured against the fixed-ceiling baseline, it made the 4 MiB case 93% slower and the
32 MiB case 210% slower. The fix was to open at the
user's ceiling and keep AIMD purely as a brake (`paceOptionsFor()` in
`src/engine/orchestrator.ts`, locked in by four tests). After the fix, adaptive matches
a hard ceiling within 0–5%, which is inside run-to-run noise.

That regression was in the author's own code and would not have been visible without
the benchmark. Note that the pre-fix numbers are **not reproducible from the current
tree** — that branch is gone, and `npm run bench` today only prints the fixed and
adaptive rows.

## Features

Everything below is implemented. The split is between what has automated tests and what
does not — and again, **none of it has run in a browser.**

### Has unit tests

- Piece planning, work-stealing, resume-by-`Range`, 416 handling
- Server probe: detects `Range` support, falls back to one connection on 200, refuses to
  split a gzipped response
- The storage capability gate: `requireStorage()` refuses the download when OPFS or
  `createSyncAccessHandle` is missing, and probes once per session rather than once per
  download (four tests). Its other half, `detectCapabilities()`, is the part that asks a
  real browser, so it has no test and cannot get one here
- AIMD concurrency: backs off on 429/503, honours `Retry-After`, coalesces penalties
- Filename handling: RFC 5987, Windows-illegal characters, no directory escape
- Header replay tiers and `declarativeNetRequest` rule construction — rules are built
  correctly per unit test; *installing* them in a browser has never run
- Mirror comparison — `compareFingerprints()` and `verifyByContent()` in
  `src/engine/adaptive/mirrors.ts`: strong-ETag match, three-window sample digest, and the
  verdict that abandons a candidate. What surrounds them is *not* tested: the rule that a
  secondary source stays out of the pool until it has been verified lives in
  `DownloadJob.verifyMirrors()` (`src/engine/orchestrator.ts:376`), and `DownloadJob` has
  no tests at all
- Shared token bucket, download queue with priorities, schedule windows across midnight
- Progress checkpointing to `storage.local` and recovery after restart, including the
  rule that an unreadable parts directory leaves everything alone rather than cleaning up
- HLS: playlist parser (variants, `BYTERANGE`, `EXT-X-KEY/MAP/GAP`, live vs VOD),
  AES-128 decryption tested against Node's real WebCrypto rather than a mock, DRM and
  SAMPLE-AES rejection, ordered segment assembly, the 188-byte MPEG-TS invariant
- Auto-mode decisions (`src/engine/policy.ts`) — the densest tests per line in the repo
- i18n catalogue and screen-reader announcements

| Test file | Tests | Area |
|---|---|---|
| `test/hls.test.ts` | 90 | playlist, keys, assembly |
| `test/adaptive.test.ts` | 82 | AIMD, headers, mirrors, streaming |
| `test/control.test.ts` | 59 | throttle, queue, schedule |
| `test/persistence.test.ts` | 59 | checkpoints, recovery |
| `test/i18n.test.ts` | 49 | messages, accessibility |
| `test/engine.test.ts` | 22 | pieces, filenames, probe |
| `test/integration.test.ts` | 20 | 16 pure functions, 4 on `requireStorage()`; not integration, despite the name |
| `test/policy.test.ts` | 16 | auto-mode take / hand-back |

### Implemented, no tests at all

15 of the 40 files in `src/` — 3,154 lines — are touched by no test at all, not even
indirectly: the background page (469), the engine manager (614), the entire UI (manager,
popup, welcome, DOM and format helpers, 1,053), the content script (270), both workers
(346), the offscreen host and the `HostBridge` stub (113), the RPC plumbing (211), and
the capability probe (78). One partial exception inside that list: `requireStorage()` in
`platform/capabilities.ts` has four tests, but `detectCapabilities()` — the half that
actually asks the browser what it supports — has none, and cannot be tested here.

An earlier version of this section said *18 files, 3,288 lines, imported by no test*.
That was a count of **direct** imports, and "imported by no test" reads as "no test
touches it" — which was not true of `engine/storage.ts`, `platform/api.ts` and
`shared/log.ts`. All three are pulled in indirectly and do execute during the run.

On top of those 15, `DownloadJob` (`src/engine/orchestrator.ts:153-967`) and `HlsJob`
(`src/engine/hls/index.ts:518-1091`) have no tests either — and those two are plain logic
that could be tested with fake ports, exactly the way `persistence.test.ts` already does.
Their absence is not the browser's fault.

Auto mode is part of this untested layer, and it is the part with real consequences.
It follows three rules: never lose a file (on any failure the original URL is handed
back to the browser), only take work it can do better (no `Range` support, or under
5 MiB — `minInterceptSize` is `5 * 1024 * 1024` — means hand it straight back), and
never stay silent too long (badge count plus a first-run notification, since the
browser's own download bar shows nothing while the engine works).

One point that is easy to misread: the size gate only rejects a download it *already
knows* to be small — `item.fileSize > 0 && item.fileSize < ctx.minSize`
(`src/engine/policy.ts:62`). A download whose size the browser has not reported yet
(`fileSize` is `-1`) is taken anyway, whatever it turns out to be, and the engine
measures it itself.

## Install and run

Node 20 or newer (esbuild targets `node20`; the tests use `node:test` and global
`fetch`).

```bash
npm install
npm run build          # → dist/chromium and dist/firefox (__DEV__=false, logging stripped)
npm run build:dev      # the same two bundles, with [df:…] logging left in
npm run build:chromium
npm run build:firefox
npm run watch          # rebuild on change; implies --dev
npm test               # 397 tests, in about a second
npm run typecheck      # tsconfig.json and tsconfig.worker.json
npm run clean
```

Load it:

- **Chromium** — `chrome://extensions` → enable Developer mode → *Load unpacked* →
  pick `dist/chromium`
- **Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
  pick `dist/firefox/manifest.json`

If you do this, you are the first person to. Bug reports from an actual browser are the
single most useful thing this project can receive.

**Build with `npm run build:dev` if you want to see what it is doing.** The default
`npm run build` sets `__DEV__=false`, and esbuild then deletes every `console.log` from
the bundles. What is left is at most one `console.warn` per bundle — the two workers and
the content script have none — and no `console.error` at all: `error()` is exported from
`src/shared/log.ts:15`, but nothing in `src/` calls it, so looking for `console.error` in
a build is looking for a line that is never emitted. `npm run build:dev` (and
`npm run watch`, which implies `--dev`) keeps the `[df:…]` `log()` calls and adds inline
source maps.

### Local test server and benchmark

```bash
npm run testserver     # http://localhost:8787
npm run bench          # in another terminal; needs testserver running
npm run verify <file>  # byte-check a downloaded file
```

The server generates bytes from `byte[i] = i % 251` instead of reading from disk, so any
downloaded file can be verified byte by byte — one piece written at the wrong offset
shows up immediately.

| Endpoint | Exercises |
|---|---|
| `/file/<bytes>` | normal path, full `Range` support |
| `/slow/<bytes>?kbps=200` | throttles **each** connection — where acceleration shows |
| `/norange/<bytes>` | server ignores `Range`; engine must fall back to one connection |
| `/gzip/<bytes>` | transfer compression; engine must disable splitting |
| `/named/<bytes>` | RFC 5987 `Content-Disposition` with non-ASCII filename |
| `/flaky/<bytes>?drop=1048576` | mid-transfer disconnect; exercises retry |
| `/stats` | `{active, peak, totalRequests}` — connection counts only, no byte totals |

<details>
<summary><b>Manual verification checklist (21 items) — the gap this project needs closed</b></summary>

Nothing here has been done. Build with `npm run build:dev` before you start, or the
consoles will be nearly empty — a default build keeps no `log()` calls and emits no
`console.error` anywhere. Logs live in `chrome://extensions` → *Details* →
*Inspect views* → `offscreen.html` (the engine runs there, not in the service worker),
or `about:debugging#/runtime/this-firefox` → *Inspect* on Firefox.

1. `/slow/104857600?kbps=200` — manager shows 8 connections, `/stats` agrees
2. `/norange/10485760` — drops to 1 connection and still completes
3. `/gzip/10485760` — splitting disabled, file not corrupted. The size has to be at
   least `MIN_MULTI_SIZE` (2 MiB, `src/engine/pieces.ts`): under it `planPieces()` already
   returns a single piece, so a smaller file — `/gzip/1048576`, say — ticks this item
   green without the gzip path ever being reached. 10 MiB is well clear of that gate
4. `/named/1048576` — saved filename is `báo cáo thử.bin`
5. `/flaky/10485760?drop=1048576` — retries and still produces a correct file
6. Pause mid-download, resume — `npm run verify` still reports byte-exact
7. Cancel mid-download — temporary file removed from OPFS
8. Every completed file passes `npm run verify`
9. Small file (`/file/1048576`) — extension leaves it to the browser
10. `/norange/104857600` — handed back to the browser, not downloaded single-threaded
11. Kill the server mid-download — the browser re-downloads it, no truncated failure
12. After each hand-back, confirm there is no re-interception loop
13. Queue — set "2 at a time", drop in 5 links, exactly 2 run; *Move to front* reorders
14. Speed limit — set 500 KB/s and confirm the total across **all** connections, not per
    connection. `/stats` cannot verify this: it reports connection counts only. Time a
    known-size download, or add a byte counter to the test server
15. Schedule — set a window about to close; download must stop and resume on time
    (Chromium slows alarms when idle, so a few extra minutes is normal)
16. Recovery — large file, kill the browser mid-download, reopen: it resumes near where
    it stopped and `verify` still passes
17. Unknown size — must download single-threaded and resume on disconnect. **No tooling
    for this yet:** the test server sets `content-length` on every route and has no
    chunked endpoint, so this needs a real-world URL or a new endpoint
18. Multiple sources — paste two links to the same file; then try a second link to a
    *different* file and confirm it is rejected with a logged reason
19. Video — open a page with HLS, popup lists it, the assembled file plays
20. Keyboard and screen reader — arrow through the list, Tab reaches every control,
    progress is announced at milestones rather than continuously
21. Language — switch the browser to English and confirm the UI follows

</details>

## Limitations

**Multiple connections only help when the server throttles per connection.** If your own
link is the bottleneck, this extension cannot make anything faster.

**It has never run in a browser**, and about 34% of `src/` has no test. The tested
pieces are tested well; the code that assembles them into a download is neither tested
nor observed.

**Type checking does not cover the tests.** Both tsconfigs include only `src/**`, so the
5,467 lines in `test/` plus the 163 lines of `bench/bench.ts` — 5,630 lines in total —
have never been type-checked; esbuild strips types without checking them.

**HLS is concatenation, not remuxing.** Streams that keep audio in a separate track
produce a second file; merging them needs ffmpeg. The CSP already allows
`wasm-unsafe-eval` and `registerRemuxer()` is a defined extension point, but no remuxer
is shipped. DASH URLs are recognised and reported; they are not downloaded. To be exact
about what is proven here: the playlist parser, variant selection and AES-128 decryption
are densely tested (90 cases), but no HLS download has ever run to completion, so no
assembled file has been produced or played.

**The file exists twice on disk for a moment** — the OPFS temporary and the final copy
handed to the browser. The engine calls `navigator.storage.estimate()` before starting,
but that code path has no tests and has never run.

**Blob URLs on large files.** The hand-off calls `storage.partAsBlobUrl()` and gives the
result to `chrome.downloads`. That assumes creating a blob URL from an OPFS `File` does
not pull the whole thing into memory. It is an assumption about browser behaviour and it
has never been checked — and the case where it would hurt, a multi-GB file, is exactly
the case this extension exists for.

**Chromium's service worker loads the entire engine bundle it does not use.**
`background.js` is 118 KB (118,084 bytes), most of it engine pulled in because `installEngineHost` is
statically imported for the Firefox branch. Wasteful, not incorrect.

**Firefox MV3 treats `host_permissions` as optional**, so the user has to grant them
manually and there is no permission-request screen yet. Firefox also cannot deliver
`runtime.sendMessage` to the sending context; that is handled by calling
`dispatchEngineRequest()` directly, which has never been verified on real Firefox.

### Never going to happen

**BitTorrent.** A browser extension cannot open a TCP socket, and WASM does not change
that — WASM runs inside the same sandbox with the same network API. WebTorrent only
speaks to WebRTC peers, so in practice it finds almost no seeders on ordinary swarms.
BitTorrent is a hard boundary, but it is not the only one, and the honest comparison is
wider than one feature. aria2 and Motrix are native programs: they also do FTP and SFTP,
Metalink, magnet links and DHT, headless operation on a server, RPC and CLI control, and
downloads that continue after the browser is closed — and they are not held to the
browser's own connection limits or to MV3's constraints, which is most of what this code
base spends its lines working around. They have also been running on real machines for
years. This has never been run in a browser once.

What an extension has and they do not is your session: it is already holding your cookies
and your login, so it can fetch a file that a standalone tool cannot see. That is the
whole of the trade.

## Privacy

There is no telemetry, and this is checkable rather than promised. The check:

```bash
grep -rnE '\bfetch\(|fetchImpl\(' src/ --include=*.ts
```

Thirteen lines. Two of them are not requests: a prose comment at
`src/engine/adaptive/headers.ts:264` that mentions `fetch()` while explaining which
headers it can and cannot set, and the wrapper definition at
`src/engine/adaptive/streaming.ts:151`. That leaves **eleven** places that issue a
request. **Ten** take a URL that came from you:

- `engine/probe.ts:58` and `:92` — the range probe that discovers the file size, and its
  `HEAD` fallback
- `engine/workers/fetch-worker.ts:97` — the byte-range requests that are the download
- `engine/orchestrator.ts:365` — a sample range read from a candidate mirror, to check it
  is the same file before trusting it
- `engine/adaptive/streaming.ts:445`, `:626`, `:674` — the single-stream path for servers
  that do not report a size, plus its size probe and its resume check
- `engine/hls/index.ts:152` and `:830` — playlist and segment
- `engine/hls/keys.ts:207` — the AES-128 key URI, which the playlist names

The eleventh is `shared/i18n.ts:303`, which reads
`runtime.getURL('_locales/<locale>/messages.json')` — an internal extension resource that
never leaves the browser.

The `fetchImpl(` half of that grep matters: `streaming.ts` takes its `fetch` as an
injectable dependency so tests can substitute one, so a plain `fetch(` grep misses three
real call sites. An earlier version of this file counted nine on exactly that mistake;
the conclusion held, the arithmetic did not. There is no `XMLHttpRequest`, no
`WebSocket`, no `sendBeacon`, no tracking pixel, and no analytics endpoint anywhere in
the code base — and PRIVACY.md runs the stronger version of this check against the built
bundles, where the number of hardcoded remote URLs is zero.

### What it asks for

No telemetry is not the same as unintrusive, so here is what the manifest requests
(`manifest/base.json`):

| Requested | What it is for |
|---|---|
| `host_permissions: <all_urls>` | Range requests go to whatever host you are downloading from, so any host has to be allowed |
| content script on `<all_urls>`, `all_frames: true` | Finds `<video>` tags and `.m3u8` URLs — meaning it can read the content of every page you open, in every frame |
| `downloads` | Hands the finished file to the browser, and intercepts downloads in auto mode |
| `storage`, `unlimitedStorage` | Settings, progress checkpoints, the OPFS temporary file |
| `notifications`, `contextMenus`, `alarms` | Completion notices, the right-click entry, schedule windows |
| `declarativeNetRequestWithHostAccess` | Sets `Referer`, `Origin`, `User-Agent` and `Cookie` on the extension's *own* requests, which `fetch()` is forbidden to set |

Said plainly: this extension can read every page you open, and when a link needs it, it
replays your `Cookie` to the server it is downloading from. That replay is last-resort
(tier 3 of `planReplay()`) and same-origin only — a captured cookie is dropped rather
than sent to a different origin (`src/engine/adaptive/headers.ts:314-323`, with tests).
The values live only in RAM, expire on a TTL, and are never written to `chrome.storage`
(`HeaderStore` in the same file). But a cookie is a login secret, and this code touches
it. PRIVACY.md goes through it permission by permission.

## Project facts

| | |
|---|---|
| TypeScript in `src/` | 13,393 lines across 40 files |
| Tests | 5,467 lines, 8 files, 397 cases, `node:test`, no test framework dependency |
| Runtime dependencies | none |
| Build dependencies | esbuild, typescript, `@types/chrome` |
| Localisation | 141 keys, Vietnamese and English, every Vietnamese key carries a translator description (enforced by a test) |
| Minimum browser | Chrome 116, Firefox 128 — declared in the manifest from API docs; never verified on a real browser |

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — why the engine lives outside the service worker,
  and the constraints that shaped everything else
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to build, test, and where help is most needed
- [SECURITY.md](SECURITY.md) — reporting a vulnerability
- [PRIVACY.md](PRIVACY.md) — what the extension does and does not collect
- [README.vi.md](README.vi.md) — bản tiếng Việt

## License

MIT. See [LICENSE](LICENSE).
