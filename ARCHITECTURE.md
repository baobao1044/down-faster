# Architecture

Down Faster is a browser extension that downloads a single file over several HTTP
connections at once, each one asking for a different byte range. It targets Chromium and
Firefox from one Manifest V3 code base.

This document is for developers: people deciding whether to contribute, and people reading
the code to judge whether it is any good. It explains the constraints that shaped the
design, the decisions those constraints forced, and the places where the design has not
been proven yet.

**Status, stated up front, because it changes how you should read everything below.**
The code has never run inside a real browser. Not once. There is no browser on the
development machine. 457 unit tests pass, both TypeScript projects typecheck clean, and
both targets build — but every path that touches OPFS, `Worker`, the offscreen document,
`chrome.alarms`, `declarativeNetRequest`, `chrome.downloads`, or the content script is
correct on paper and in unit tests only. Section 12 maps exactly what is covered and what
is not.

---

## Table of contents

1. [The constraint that shapes everything](#1-the-constraint-that-shapes-everything)
2. [Where the engine lives](#2-where-the-engine-lives)
3. [HostBridge, and why it is not over-engineering](#3-hostbridge-and-why-it-is-not-over-engineering)
4. [Data flow](#4-data-flow)
5. [Exactly one writer worker](#5-exactly-one-writer-worker)
6. [More pieces than connections](#6-more-pieces-than-connections)
7. [Lifecycle of a piece](#7-lifecycle-of-a-piece)
8. [Backpressure by write acknowledgement](#8-backpressure-by-write-acknowledgement)
9. [One token bucket for the whole extension](#9-one-token-bucket-for-the-whole-extension)
10. [AIMD is a brake, not an accelerator](#10-aimd-is-a-brake-not-an-accelerator)
11. [Mirrors must be proven identical before use](#11-mirrors-must-be-proven-identical-before-use)
12. [What the tests actually prove](#12-what-the-tests-actually-prove)
13. [Chromium and Firefox, side by side](#13-chromium-and-firefox-side-by-side)
14. [Roads considered and rejected](#14-roads-considered-and-rejected)
15. [Repository layout and commands](#15-repository-layout-and-commands)
16. [If you want to contribute](#16-if-you-want-to-contribute)

---

## 1. The constraint that shapes everything

Multi-connection downloading is not hard in the abstract. Issue N requests with `Range`
headers, write the responses to the right offsets, done. Every design decision in this
repository comes from the fact that a Manifest V3 extension is a hostile place to do that.

Three platform facts do most of the shaping:

- **A Chromium MV3 background context is a service worker.** It has no DOM. It cannot call
  `new Worker(...)`, and it cannot call `URL.createObjectURL(...)`. Both are load-bearing
  here: workers are how the download runs off the main thread, and a blob URL is how the
  finished file is handed to `chrome.downloads`.
- **Service workers are evicted.** Long-lived in-memory state is not a thing you may
  assume. Progress has to be checkpointed somewhere durable, and checkpoints have to be
  conservative about what they claim.
- **`fetch()` refuses to set the headers that make many links work.** `Referer`, `Origin`
  and `Cookie` are forbidden request headers; `User-Agent` was dropped from that list in the
  spec but Chrome still strips it (crbug 571722). Setting them is a silent no-op, not an
  error. The full list and the reasoning is at the top of `src/engine/adaptive/headers.ts`.

All three are taken from platform documentation and from the behaviour this code is written
against. Like everything browser-facing in this repository, none of them has been re-checked
in a running browser; section 12 says so again in full.

Everything below is downstream of these.

## 2. Where the engine lives

The engine does not live in the background script on Chromium. It lives in an **offscreen
document** — an invisible extension page created with `chrome.offscreen.createDocument()`,
declared with reasons `['WORKERS', 'BLOBS']` (`src/platform/api.ts:54`). That page exists
for no reason other than to be a DOM context where `new Worker()` and
`URL.createObjectURL()` work.

On Firefox the MV3 background is an event page, which already has a DOM, so the engine is
installed directly into it and no offscreen document is built at all. `scripts/build.mjs`
only adds the offscreen entry point for the Chromium target (`CHROMIUM_ONLY`).

The engine host is also deliberately **not** the manager page. From
`src/engine/manager.ts:47`:

> The manager page cannot play this role, because the user closing the tab would kill
> every job.

So: one code base, two host contexts, selected at build time through the `__TARGET__`
define and the thin `src/platform/api.ts` shim.

## 3. HostBridge, and why it is not over-engineering

An offscreen document is assumed to have access to `chrome.runtime` and essentially nothing
else — no `downloads`, no `storage`, no `notifications`, no `action`, no
`declarativeNetRequest`. That assumption is written into `src/engine/host.ts:8-12` and it
is the reason the whole `HostBridge` interface exists.

The rule the engine follows is: **the engine never calls a browser API directly.** It
states an intent, and whichever context has the permission carries it out.

```ts
export interface HostBridge {
  saveFile(request: { taskId: string; blobUrl: string; filename: string }): Promise<void>;
  handBack(request: { url: string; filename?: string }): Promise<void>;
  setActiveCount(count: number): void;
  loadSettings(): Promise<Settings>;
  store: PersistenceStore;
  notify(request: { id: string; title: string; message: string }): void;
  applyHeaderRules(request: { add: HeaderRuleSpec[]; removeIds: number[] }): Promise<boolean>;
}
```

Two consequences are worth calling out, because they are the parts that look strange until
you know why:

**Storage goes through the bridge too.** `src/engine/persistence.ts:15-19` forbids itself
from importing `platform/api`. Calling `api.storage.local` there would work perfectly on
Firefox and fail silently on Chromium — the worst possible failure mode, since the download
keeps running and only the resume record is lost. Instead the store is injected: Firefox
wires it straight to `storage.local`, Chromium wires it through the bridge to the
background.

**Header rewriting is a data structure, not an API call.** `planReplay()` produces a plain
`HeaderRuleSpec`; `buildRuleSpec()` shapes it; the background converts it to a Chrome
`declarativeNetRequest` rule in `toDnrRule()` and installs it as a session rule. The engine
never sees a DNR object. This is what makes the header planner testable without a browser —
and `test/adaptive.test.ts` does test it hard, including the rule that secrets are never
replayed to a different origin.

The bridge is also where a genuine correctness trap was handled. `offscreen.ts` has two
call helpers: `ask()` swallows failures, `demand()` throws. Persistence must use `demand()`,
because a swallowed error would report "checkpoint written" to `TaskPersistence` when
nothing was written, and the next resume would trust a record that does not exist
(`src/offscreen/offscreen.ts:25-36`).

## 4. Data flow

Context topology:

```
Chromium (MV3 service worker)                 Firefox (MV3 event page)
+--------------------------------+            +--------------------------------+
| background.js                  |            | background.js                  |
|   downloads, storage           |            |   downloads, storage           |
|   notifications, action        |            |   notifications, action        |
|   declarativeNetRequest        |            |   declarativeNetRequest        |
|   alarms, contextMenus         |            |   alarms, contextMenus         |
|                                |            |                                |
|   no DOM -> no Worker          |            |   has DOM                      |
|           -> no blob: URL      |            |   DownloadManager runs HERE    |
+---------------+----------------+            +--------------------------------+
                |                                  in-process function calls
                |  HostBridge over                 via dispatchEngineRequest()
                |  chrome.runtime.sendMessage
                v
+--------------------------------+
| offscreen.html                 |
|   DownloadManager              |
|   DownloadJob / HlsJob         |
|   ThrottleServer, HeaderStore  |
|   chrome.runtime only          |
+--------------------------------+
```

Per-download worker topology, identical on both browsers:

```
        engine host context (offscreen document, or Firefox event page)
        +--------------------------------------------------------------+
        |  DownloadJob                                                 |
        |    pieces[]   assignment map   ConcurrencyController         |
        +----+--------------------+----------------------+------------+
             |                    |                      |
   postMessage {type:'piece', pieceIndex, url, start, end, headers}
             v                    v                      v
      +-------------+      +-------------+        +-------------+
      | fetch       |      | fetch       |  ...   | fetch       |
      | worker 0    |      | worker 1    |        | worker N-1  |
      +------+------+      +------+------+        +------+------+
             |                    |                      |
   WriteRequest {offset, buffer}  |  one MessagePort each, buffer transferred
             v                    v                      v
        +--------------------------------------------------------------+
        |                   writer worker  (exactly ONE)                |
        |         FileSystemSyncAccessHandle — exclusive lock           |
        +------------------------------+-------------------------------+
                                       |
                                       v
                          OPFS   parts/<taskId>.part
```

`WriteAck {written}` travels back along the same `MessagePort`. That return path is the
backpressure valve; see section 8.

The finished file leaves through `storage.partAsBlobUrl()`, which opens the OPFS part file
as a `File` and wraps it in a blob URL, and then through `HostBridge.saveFile()` to
`chrome.downloads.download()`. That is why the file briefly exists twice on disk: once as
the OPFS temp part, once as the browser's saved copy. There is no way around this while the
only sanctioned handover to the download manager is a URL.

## 5. Exactly one writer worker

`FileSystemFileHandle.createSyncAccessHandle()` is the fast path for random-access writes
in a worker: synchronous `write(buffer, {at: offset})` straight to disk, no RAM
accumulation. It also **takes an exclusive lock on the file**, so two workers cannot each
open their own handle to `parts/<taskId>.part`. That lock is documented platform behaviour,
not something this repository has observed: no line of `writer-worker.ts` has ever run.

That single platform fact decides the entire worker topology. There is one writer worker per
download, and every fetch worker forwards its buffers to it:

```ts
// src/engine/workers/writer-worker.ts
handle = await file.createSyncAccessHandle();
if (size > 0) handle.truncate(size);   // preallocate, so middle pieces don't extend the file
```

Three details in that file matter more than they look:

- **`truncate(size)` at open time.** The part file is full-size from the first byte
  onwards, so pieces can be written into the middle without growing the file incrementally.
  A side effect drives recovery: file size is a consistency check, never a progress
  indicator. The piece map is the only source of truth about progress
  (`src/engine/recovery.ts:9-12`).
- **The ack is posted in a `finally` block.** If a write throws and the ack is skipped, the
  fetch worker waiting on it never wakes up and the download hangs with no error. The ack
  reports the byte count on every path, including the failure path.
- **One writer is enough.** The design assumes disk is faster than the network here, so
  serialising writes costs nothing worth reclaiming. That is an assumption, not a
  measurement — `bench/bench.ts` swaps the writer for a `Buffer` and never exercises this
  path. What one writer does buy for certain is identical behaviour on both browsers.

**Nothing above runs until the environment is checked.** `DownloadJob.openWriter()` calls
`requireStorage()` (`src/platform/capabilities.ts:70`) before it constructs the worker, and
every download path — ordinary file, resume, unknown-size stream — goes through that one
call (`src/engine/orchestrator.ts:457`). A browser with no OPFS, or with no
`createSyncAccessHandle()` on the file handle, fails there, immediately, with a sentence
naming the capability that is missing. Without the gate the engine would probe, plan pieces
and spawn workers before dying on the first `createSyncAccessHandle()` call, reporting an API
name the user has never heard of — and in auto mode the download would already have been
taken away from the browser by then. Failing early is what lets `fail()` hand the original
URL back for a normal browser download instead. The detection runs once per session and the
result is memoised, because creating and deleting a probe file on OPFS for every download is
exactly the pattern a file system dislikes. This is not an exotic branch: OPFS is absent from
the private-browsing mode of some browsers, and `createSyncAccessHandle` exists only inside
workers. Four tests in `test/integration.test.ts` cover the gate — missing OPFS, missing sync
handle, the passing case, and the once-per-session memoisation — by injecting a fake
detector. Four more tests drive `detectCapabilities()` with an injected fake storage,
including the main-thread vs worker split behind the capability-probe fix. Only the
real `navigator.storage` call itself has still never run.

The HLS path reuses the same worker and the same `WriteRequest`/`WriteAck` protocol through
`OrderedSink` in `src/engine/hls/assemble.ts`, which additionally enforces segment ordering
— HLS segments must land in playlist order, unlike byte-range pieces which are
self-addressing.

## 6. More pieces than connections

The obvious plan for 8 connections is 8 equal slices. It fails in a specific, common way:
one connection lands on a slow CDN node, seven finish and sit idle, and the whole file waits
on the straggler.

`planPieces()` cuts **four pieces per connection** and lets any idle worker take the next
pending one. Work stealing flattens speed differences with no measurement at all
(`src/engine/pieces.ts:8-16`).

```ts
const MIN_MULTI_SIZE = 2 * 1024 * 1024;   // below this, one connection
const MIN_PIECE      = 1024 * 1024;       // 1 MiB floor
const MAX_PIECE      = 16 * 1024 * 1024;
const PIECES_PER_CONNECTION = 4;

const target    = Math.ceil(size / (options.connections * PIECES_PER_CONNECTION));
const pieceSize = Math.min(MAX_PIECE, Math.max(MIN_PIECE, target));
```

**The 1 MiB floor is also a ceiling on speedup, and this is important enough that the
README states it as a limitation rather than hiding it.** A 4 MiB file yields exactly four
pieces no matter how many connections the user configured, so at most four connections can
ever be busy. `spawnFetchers()` reinforces this by never spawning more workers than there
are pieces, and `paceOptionsFor()` clamps the concurrency ceiling to `pieces.length`.

Measured by calling the real `planPieces()` with `connections: 8`:

| File size | Pieces |
|-----------|--------|
| 1 MiB     | 1      |
| 2 MiB     | 2      |
| 4 MiB     | 4      |
| 7 MiB     | 7      |
| 7.5 MiB   | 8      |
| 32 MiB    | 32     |

The second piece appears at 2 MiB exactly — that is the `MIN_MULTI_SIZE` gate — and the
eighth at 7,340,033 bytes, one byte past 7 MiB. So a user who sets 8 connections does not
actually get 8 of them until the file is larger than 7 MiB.

Measured with `npm run bench` on this machine, six runs — the same ranges README.md,
README.vi.md and CONTRIBUTING.md quote:

| File   | Per-connection throttle | 1 connection    | Ceiling 8, AIMD row | Peak actually used | Speedup |
|--------|-------------------------|-----------------|---------------------|--------------------|---------|
| 4 MiB  | 500 KB/s                | 8.22 – 8.26 s   | 2.03 – 2.04 s       | **4**              | 4.0x    |
| 32 MiB | 2000 KB/s               | 16.65 – 16.74 s | 2.05 – 2.07 s       | 8                  | 8.1x    |

Ranges rather than single figures, on purpose. The speedup ratio was identical in all six
runs; the raw times moved by about 1%. Quoting one number to the hundredth of a second would
claim a precision this measurement does not have — and that is exactly how four documents in
this repository once ended up quoting four different values (8.25 / 8.23 / 8.24 / 8.26) for
the same measurement. All six runs verified the output byte for byte.

Method, because the number is meaningless without it: `scripts/testserver.mjs` sleeps after
each chunk **per response**, so each connection is throttled independently. `bench/bench.ts`
imports the real `planPieces()`, `takeNextPending()`, `remainingRange()`,
`ConcurrencyController` and `paceOptionsFor()`, and substitutes a Node loop for the fetch
worker and a `Buffer` for OPFS. Every run verifies the output byte by byte against
`byte[i] = i % 251`. Loopback, so RTT is near zero, no TLS, no packet loss, no real CDN.

**These numbers only hold when the server throttles each connection separately.** If the
bottleneck is the user's own link, splitting it into eight streams changes nothing. That is
physics, not a tuning problem.

Run-to-run variance is real and worth stating rather than hiding. Across the six runs the
32 MiB single-connection case stayed between 16.65 s and 16.74 s and the 4 MiB case between
8.22 s and 8.26 s — roughly 1% either way, while the ratio the table actually claims did not
move at all. The bench's separate `fixed` row for 4 MiB — hard ceiling 8, AIMD off — has
moved between roughly 1.9 s and 2.1 s across runs, which is the same order as the gap it is
being compared against; that is why "AIMD matches a hard ceiling within 0–5%" is stated as
*inside the noise* rather than as a win. It is also why every document here quotes a range
instead of a single figure. Treat every bench number as loopback on one machine.

## 7. Lifecycle of a piece

```
                 planPieces(size, options)
                            |
                            v
                        +---------+
      takeNextPending() |         |  worker idle, within the concurrency allowance
      sets state -------> pending +--------------------+
                        |         |                    |
                        +----^----+                    v
                             |                    +--------+
      requeue(): attempts++, |                    | active |
      state -> pending       |                    +---+----+
                             |                        |
                             |         FetchEvent     |
                             |     +------------------+------------------+
                             |     |                  |                  |
                             |  'progress'         'done'            'failed'
                             |     |                  |                  |
                             |     v                  v                  |
                             | piece.received      +------+              |
                             | += bytes            | done |              |
                             | (survives failure)  +------+              |
                             |                                           |
                             +-------------------- retryable, and -------+
                                                   attempts <= maxRetries
                                                            |
                                                    otherwise
                                                            v
                                                        +--------+
                                                        | failed |
                                                        +---+----+
                                                            |
                                            source 'auto' --+-- source 'manual'
                                                  |               |
                                          hand back to        report the
                                          the browser         error to the user
```

The detail that makes retries cheap: `piece.received` is **not** reset on failure.
`remainingRange(piece)` returns `{start: piece.start + piece.received, end: piece.end}`, so
a connection that dies 700 KB into a 1 MiB piece resumes at byte 700 K, not at zero. The
fetch worker flushes its pending progress count before throwing precisely so that this
number is accurate at the moment of failure
(`src/engine/workers/fetch-worker.ts:173-182`).

A second detail worth knowing before you touch this code: `If-Range` is attached to every
piece request for which the server supplied a validator — the ETag if there is one,
otherwise `Last-Modified`, and no header at all if there is neither
(`orchestrator.ts:571-579`). If the file changed mid-download, the server answers 200
instead of 206, and the fetch worker refuses to write it for any piece that does not start
at byte 0 (`fetch-worker.ts:110-118`). A visible failure beats a silently corrupted file.

## 8. Backpressure by write acknowledgement

The network is frequently faster than the disk. Without a brake, unwritten buffers pile up
in the fetch worker's memory — which destroys the exact benefit OPFS was adopted for.

The brake is the write ack, and it is deliberately simple:

```ts
// src/engine/workers/fetch-worker.ts
function reserve(bytes: number): Promise<void> {
  inflight += bytes;
  if (inflight < highWaterMark) return Promise.resolve();
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function onAck(event: MessageEvent<WriteAck>): void {
  inflight = Math.max(0, inflight - event.data.written);
  releaseWaiters();
}
```

The read loop awaits `reserve(length)` before posting the buffer. Above the high-water mark
(8 MiB by default, `DEFAULT_OPTIONS.writeHighWaterMark`) the worker simply stops calling
`reader.read()`, and TCP backpressure propagates the rest of the way on its own.

Two places had to be made safe against permanent hangs:

- **Abort.** A piece may be parked in `reserve()` or parked waiting for rate-limit
  allowance. The abort handler resets `inflight`, releases all waiters, and resets the
  throttle client; otherwise the worker never accepts another piece
  (`fetch-worker.ts:240-249`).
- **Disposal.** `createPortSink().dispose()` in the streaming path releases waiters on the
  way out for the same reason (`src/engine/adaptive/streaming.ts`).

The single-connection streaming path (used when the server hides `Content-Length`) reuses
this identical `WriteRequest`/`WriteAck` protocol via `createPortSink()`, so there is one
backpressure mechanism in the codebase, not two.

## 9. One token bucket for the whole extension

When a user types "500 KB/s" they mean the extension should consume 500 KB/s. Not 500 KB/s
per connection, and not 500 KB/s per download. So there is exactly one `TokenBucket`, owned
by `DownloadManager`, and every fetch worker in every job draws from it.

The shape is a server/client split across the worker boundary:

- `ThrottleServer` (host side) holds the bucket and hands out grants to waiting clients in
  FIFO order — the queue *is* the round-robin.
- `ThrottleClient` (worker side) holds a local balance, asks for more when it hits zero,
  and is allowed to go negative.

The negative balance is intentional. You cannot know how many bytes the next
`reader.read()` will return, so the worker asks *before* reading and accounts *after*. The
error is therefore bounded at one chunk per worker while the average rate stays correct
(`src/engine/throttle.ts:375-381`).

Three decisions here are non-obvious and each is documented at the point of decision:

- **Tokens are recomputed from the wall clock on every touch**, never accumulated by timer
  tick. An offscreen document is a hidden page and its timers can be throttled; clock-based
  refill means a late timer makes delivery bursty rather than making the rate wrong.
- **`SharedArrayBuffer` + `Atomics.wait` was rejected.** Blocking the fetch worker's message
  loop would also block the `WriteAck` channel from the writer — and the backpressure valve
  in section 8 depends on that channel. Deadlock by construction
  (`src/engine/throttle.ts:9-12`).
- **A rate limit reduces the connection count.** At 200 KB/s split eight ways, each socket
  idles for seconds between grants and CDNs start closing them, which pushes the engine into
  a pointless retry loop. `connectionsForRate()` caps connections at
  `rate / MIN_RATE_PER_CONNECTION` (256 KB/s).

Honest gap: `src/engine/throttle.ts` has thorough unit tests in `test/control.test.ts`
(token bucket, two workers sharing round-robin, `setRate` mid-flight, `dispose()` not
hanging a worker), but `bench/bench.ts` does not import it. **The shared bucket has never
been measured under load.**

## 10. AIMD is a brake, not an accelerator

This section is the one to read if you want to know whether the engineering here is
serious, because it describes the project's own code being wrong and the measurement that
caught it.

`ConcurrencyController` (`src/engine/adaptive/concurrency.ts`, 619 lines, 82 tests in
`test/adaptive.test.ts`) borrows TCP's additive-increase / multiplicative-decrease idea:
step the connection count up while throughput improves, cut it hard when the server pushes
back. It adds two things TCP does not need — a remembered `ceiling` for the level that
caused an error, so it does not walk into the same wall a minute later, and a notion of an
"inconclusive window" so the end of a file is not mistaken for saturation.

The original wiring started at 2 connections and climbed. That is the textbook AIMD shape,
and it was wrong here.

**The arithmetic.** `DEFAULT_CONCURRENCY` has `windowMs: 2000` and `settleWindows: 1`. After
any change to the limit, one window is discarded as unsettled, so a step takes two windows —
about 4 seconds. Climbing from 2 to 8 is six steps: roughly 24 seconds of ramp, longer than
most downloads take in total.

**The measurement.** Against a fixed ceiling of 8, the ramping version measured **93% slower
on the 4 MiB case and 210% slower on the 32 MiB case.**

**The fix.** `paceOptionsFor()` opens at the ceiling the user asked for:

```ts
// src/engine/orchestrator.ts:984
export function paceOptionsFor(
  options: DownloadOptions,
  pieceCount: number,
): Partial<ConcurrencyOptions> {
  const max = Math.max(1, Math.min(options.connections, pieceCount || 1));
  return {
    min: Math.max(1, Math.min(options.minConnections, max)),
    max,
    start: max,          // start AT the ceiling, do not climb toward it
  };
}
```

The controller keeps its entire downward half. HTTP 429, 503, 509 and `Retry-After` still
cut the limit immediately, still install a temporary ceiling one step below the level that
failed, and `relaxCeiling()` still lifts that ceiling one step at a time. What was removed
is only the upward ramp toward a number the user already stated.

After the fix, adaptive is level with a hard ceiling: runs on this machine land at +4% to
+5% on 4 MiB and +-0% on 32 MiB, inside run-to-run noise. `npm run bench` prints that
difference on every run, so unlike the 93% / 210% pair above it is a figure you can check
yourself.

**Reproducibility, stated plainly:** the 93% / 210% figures were measured before the fix, in
a previous session. That code path is deleted, so `npm run bench` today prints only the
`fixed` and `adaptive` rows and cannot reproduce them. The reasoning is preserved in the
`paceOptionsFor()` doc comment and locked by four tests in `test/integration.test.ts`. If
you are auditing, treat the two percentages as a recorded historical measurement, not as
something you can re-run.

**Two traps to know before you edit this file.**

`DEFAULT_CONCURRENCY.start` is **still 2**. Only `paceOptionsFor()` overrides it. If you
construct a `ConcurrencyController` directly anywhere else, you will silently get the slow
ramp back.

And the reason `bench/bench.ts` imports `paceOptionsFor` instead of copying its numbers is
written into the bench file itself: a copied constant drifts exactly when the engine
changes, and then the benchmark measures an algorithm nobody runs.

Two further pieces of controller design earn their complexity, and both exist because the
naive version produces a specific wrong answer:

- **`noteActive()` / inconclusive windows.** Near the end of a file only two pieces remain,
  so only two workers run, so throughput drops — and a naive controller concludes
  "saturated" and permanently lowers the limit while the network is perfectly fine. The
  controller records the minimum active count per window and refuses to draw conclusions
  from a window that did not have full occupancy.
- **De-duplicated penalties.** A single throttling event is reported by all N workers within
  milliseconds. Penalising N times would drive both the limit and the ceiling to `min`, and
  N x `ceilingRelaxMs` would be needed to recover — one 429 would kill the whole download.
  `applyPressure()` returns early while a cooldown is already active. There is a further
  subtlety handled explicitly: `Retry-After: 0` opens no de-duplication window, so that case
  is deliberately routed to the default backoff instead (`concurrency.ts:376-397`).

## 11. Mirrors must be proven identical before use

If the user supplies several URLs for "the same file", splitting pieces across them is only
safe if they really are byte-identical. Getting this wrong produces a corrupted file that
raises no error at all — the worst failure mode available.

The hard part is not distributing work; it is knowing when you are *allowed* to conclude.
ETag inequality is not evidence of difference: two CDNs serving identical bytes almost
always mint different ETags. Treating that as "different file" rejects every legitimate
mirror; treating it as "same file" is reckless. So `compareFingerprints()` returns a
four-level verdict rather than a boolean:

| Verdict     | Meaning                                                     | Action |
|-------------|-------------------------------------------------------------|--------|
| `different` | Sizes differ, or same origin with different ETags            | reject |
| `same`      | Size matches and both ETags are strong and equal             | accept |
| `likely`    | Size matches, but the ETag evidence is weak or absent        | sample the content |
| `unknown`   | At least one side has no `Content-Length`                    | reject |

Weak ETags (`W/"..."`) are downgraded to `likely` on purpose. RFC 7232 requires strong
comparison for any claim about bytes; `W/` only promises semantic equivalence, and nginx and
Apache both attach `W/` to compressed responses, so this is common rather than exotic.

A `likely` verdict is settled by evidence, not by optimism. `verifyByContent()` hashes three
64 KiB windows — head, middle and tail — from each candidate, mixes size and window layout
into the digest so two differently-sized files can never collide, and compares SHA-256.
Cost: 192 KiB per mirror. Taking the tail matters: two different builds of the same release
are usually identical at the head.

The sequencing in `DownloadJob` is the part to copy if you write something similar:
**secondary sources do not enter the pool at all until verification passes.** The download
runs on the origin the whole time, and `verifyMirrors()` calls `pump()` afterwards only if
the pool actually grew (`src/engine/orchestrator.ts:340-421`). Verification never delays the
download, and an unverified mirror never touches a byte.

Be precise about which half of that is proven. The **verdict** — `compareFingerprints()`
and `verifyByContent()` in `src/engine/adaptive/mirrors.ts` — is covered by
`adaptive.test.ts` and `integration.test.ts`. The **sequencing** — keeping a secondary
source out of the pool until it has been verified — lives in `DownloadJob.verifyMirrors()`
(`src/engine/orchestrator.ts:376`), and `DownloadJob` has no tests at all. The rule above
is a design intent read off the code, not a behaviour a test holds in place.

## 12. What the tests actually prove

457 tests, `node:test`, in about a second. Reproduce with `npm test`.

| File | Tests | Covers |
|------|-------|--------|
| `test/adaptive.test.ts` | 82 | AIMD grow/shrink, 429/503, `Retry-After`, error ceiling, penalty de-duplication; header classification, tiered replay, `buildRuleSpec`, `RuleIdAllocator`, `HeaderStore` TTL + LRU, redaction; mirror fingerprints and the `MirrorPool` comparison itself (not `DownloadJob`'s ordering around it); stream resume by `Range`, 416, pause/abort, `createPortSink` backpressure |
| `test/hls.test.ts` | 90 | Playlist parser (attributes, variants, `BYTERANGE`, `EXT-X-KEY`/`MAP`/`GAP`, live vs VOD), AES-128 with big-endian IV and PKCS#7, DRM and SAMPLE-AES refusal, `KeyStore`, `OrderedSink`, `validateForConcat` |
| `test/control.test.ts` | 59 | Token bucket, two workers sharing round-robin, `setRate` mid-flight, `dispose()` releasing waiters; queue concurrency cap, priority, `moveToFront`, pause holding its slot; schedule windows across midnight, absolute-`when` alarms |
| `test/persistence.test.ts` | 59 | Record encode/decode, checkpoint ordering, recovery decisions |
| `test/i18n.test.ts` | 49 | Message table, locale override, screen-reader helpers in `src/ui/a11y.ts` |
| `test/engine.test.ts` | 28 | `planPieces`, filename resolution (RFC 5987, Windows-illegal names, no directory escape), probe behaviour on 206/200/gzip, redirect final-URL reuse, and the plain-GET fallback when ranged GET fails |
| `test/integration.test.ts` | 24 | `DEFAULT_SETTINGS` -> `toDownloadOptions`, `failureKind`, `compareFingerprints`, four tests locking `paceOptionsFor`, four driving `requireStorage()` with an injected probe, and four driving `detectCapabilities()` with an injected fake storage |
| `test/policy.test.ts` | 16 | Auto-mode interception rules — 16 tests for 65 lines, the densest file in the repo |
| `test/format.test.ts` | 10 | UI formatters — `bytes`, `speed`, `eta`, `stateLabel`, and the unit/duration keys from the message table |
| `test/messaging.test.ts` | 3 | engine-channel startup race — commands queued while the offscreen listener is pending, released FIFO on a successful ping, dropped with a warning on timeout |

Three details are worth pointing out. `test/hls.test.ts` builds its AES-128 fixtures with
Node's real `crypto.subtle.encrypt` and makes the engine decrypt them, rather than mocking
the crypto. Several tests lock *safe* behaviour rather than correct behaviour — for example,
that an unreadable parts directory results in nothing being cleaned up at all. And the
188-byte MPEG-TS invariant test catches a truncated stream that fake padding would otherwise
hide.

### The gaps, stated precisely

Cross-referencing every test import against `find src -name '*.ts'`:

**12 of 41 source files (2,820 lines) are touched by no test at all, not even
indirectly.**

```
src/engine/manager.ts               614     src/shared/rpc.ts              142
src/ui/manager.ts                   547     src/engine/workers/writer-worker.ts  82
src/background/index.ts             472     src/offscreen/offscreen.ts      80
src/content/media-detect.ts         270     src/shared/protocol.ts          69
src/engine/workers/fetch-worker.ts  264     src/engine/host.ts              33
src/ui/popup.ts                     226     src/ui/welcome.ts               21
```

That is precisely the glue layer: HostBridge, offscreen, both workers, the content
script, and three of the five UI files (manager, popup, welcome) — the format and DOM
helpers now run under `format.test.ts` and `i18n.test.ts` (via `ui/a11y.ts`).

Reachability here comes from esbuild's metafile for the test bundle, so a file counts as
covered even when no test names it in an import. An earlier revision of this section said
*18 of 40 source files (3,288 lines) are imported by no test* — that was a count of
**direct** imports, phrased as though it meant "no test ever runs this code". It was wrong
for `src/engine/storage.ts` (88), `src/platform/api.ts` (67) and `src/shared/log.ts` (17):
all three are pulled in transitively and do execute during `npm test`.

`src/platform/capabilities.ts` no longer belongs in that list at all. Four tests in
`test/integration.test.ts` cover `requireStorage()`, the gate `DownloadJob.openWriter()`
calls before it builds the writer, and four more drive `detectCapabilities()` with an
injected fake storage — main thread vs worker, the split behind the capability-probe
fix. Only the real `navigator.storage` call is still browser-only.

**Worse, the two largest classes in the project live in files that *are* imported by tests,
but are themselves untested.** `DownloadJob` spans `orchestrator.ts:153-967` (815 lines) and
no test constructs one — `test/integration.test.ts` imports only the two pure functions
`failureKind` and `paceOptionsFor` from that file. `HlsJob` spans `hls/index.ts:518-1091`
(~574 lines) and `test/hls.test.ts` imports only `classifyMediaUrl` and
`buildSegmentRequests` from those 1,188 lines. `probeMedia`, `resolvePlaylist` and
`planMediaDownload` are untested too.

That is **4,543 lines, about 34% of `src/`, with no test.** The honest summary is: the
*pieces* are tested carefully, and the thing that *assembles* the pieces into an actual
download is neither tested nor ever executed.

Note also that `test/integration.test.ts` is misnamed. Twenty of its 24 tests are
assertions on pure functions; four drive `requireStorage()` with an injected probe, and
four drive `detectCapabilities()` with an injected fake storage. Nothing is wired to a
browser, a worker or a real file. Do not read the filename as evidence that integration
tests exist.

**Typecheck scope.** `npm run typecheck` runs two projects and both pass, but `tsconfig.json`
includes only `src/**/*.ts` (excluding workers) and `tsconfig.worker.json` includes only the
workers plus three shared files. Neither includes `test/` or `bench/`, and `scripts/test.mjs`
uses esbuild, which strips types without checking them. So 5,966 lines of test code and 163
lines of bench code — 6,129 lines in total — have never been typechecked. The base config is `strict` with
`noUncheckedIndexedAccess`, but also `skipLibCheck: true` and
`exactOptionalPropertyTypes: false` — good, not maximal.

**What the bench does not cover.** `bench/bench.ts` imports `planPieces`, `remainingRange`,
`takeNextPending`, `ConcurrencyController` and `paceOptionsFor`. It therefore proves the
piece-planning and concurrency algorithms. It does not touch the writer worker, `MessagePort`
transfer, write-ack backpressure, OPFS, `throttle.ts`, retries, mirrors, HLS, persistence, or
`DownloadJob`. It runs six iterations per configuration on one machine and publishes the
spread — about 1% on the raw seconds, none at all on the ratios — which says nothing about
a second machine.

**And nothing has ever run in a browser.** OPFS, `createSyncAccessHandle`, `Worker`, the
offscreen document, `chrome.alarms`, `declarativeNetRequest`, `chrome.downloads` and the
content script are all in the untested-and-unexecuted intersection. The DNR case shows the
distinction worth keeping in mind: the *computation* of a rule (`buildRuleSpec`,
`RuleIdAllocator`) is thoroughly tested; *installing* that rule in a browser has never
happened.

The README carries a 21-item manual test checklist aimed exactly at this gap.

## 13. Chromium and Firefox, side by side

| | Chromium | Firefox |
|---|---|---|
| Background context | Service worker (`background.service_worker`) | Event page (`background.scripts`) |
| DOM in background | No | Yes |
| Engine host | Offscreen document (`offscreen.html`) | The background page itself |
| Offscreen reasons | `['WORKERS', 'BLOBS']` | n/a |
| Extra permission | `offscreen` | n/a |
| Engine <-> host API calls | `chrome.runtime.sendMessage` -> HostBridge | Direct function calls |
| Engine command dispatch | `runtime.onMessage` -> `dispatchEngineRequest` | `dispatchEngineRequest` called inline |
| Minimum version | `minimum_chrome_version: 116` | `strict_min_version: 128.0` |
| esbuild target | `chrome116` | `firefox128` |
| Bundle sizes (this build) | `background.js` 118,084 B, `offscreen.js` 108,879 B | `background.js` 118,083 B |

Everything below the host boundary — pieces, workers, OPFS, throttle, mirrors, HLS — is
identical code on both.

Three differences deserve their own note.

**Firefox cannot `sendMessage` to itself.** `runtime.sendMessage` does not deliver to the
sending context, and on Firefox the engine *is* the sending context. Messages would vanish
silently. `background/index.ts` handles this by keeping a `localReady` promise and calling
`dispatchEngineRequest()` directly instead of going through messaging
(`src/background/index.ts:208-221`). The initialisation is asynchronous because settings must
be loaded first, and the first command often arrives in the same tick — hence a promise
rather than a plain reference. **Not verified on real Firefox.**

**Firefox MV3 treats `host_permissions` as optional**, granted by the user rather than at
install time. There is no permission-request UI in this codebase: `grep -rn
'permissions.request' src/` returns nothing, and neither manifest declares
`optional_host_permissions`. The build's manifest overlay is a shallow merge, so the Firefox
manifest inherits `host_permissions: ["<all_urls>"]` from `manifest/base.json` unchanged. The
platform behaviour itself is a documented Firefox property I have not verified in a browser;
the absence of request UI is verified in this repo.

**The Chromium service worker carries the engine it never uses.** `background/index.ts`
statically imports `installEngineHost` for the Firefox branch, so esbuild pulls the whole
engine graph into the service worker bundle: `dist/chromium/background.js` is 118,084 bytes,
almost exactly the same as the Firefox bundle that genuinely needs it, and
`dist/chromium/offscreen.js` is another 108,879 bytes of the same engine. Wasteful, not
wrong — a dynamic `import()` behind the `isFirefox` branch would fix it. Good first
contribution.

## 14. Roads considered and rejected

Several of these are recorded as comments at the decision point in the code, which is the
right place for them; they are collected here for readers doing a survey rather than a
diff.

**BitTorrent, DHT, magnet links — permanently out of scope.** An extension cannot open a raw
TCP or UDP socket; the platform exposes no such API. WASM does not change this, because WASM
has no more socket access than its host. WebTorrent works, but only over WebRTC, so it can
only reach peers that are themselves WebRTC-capable browsers — for an ordinary Linux ISO
swarm there is effectively nobody to talk to. This is a hard boundary between this project
and aria2 or Motrix, which are native programs and can do it properly — and not the only
one: FTP/SFTP, Metalink, headless and RPC operation, and downloads that outlive the
browser are all theirs too. *(Platform claim, stated from documented browser behaviour,
not verified in this repo.)*

**A native helper via `runtime.connectNative` — rejected as a product decision.** Delegating
to aria2 through native messaging is technically possible and would deliver BitTorrent, but
it requires the user to install a separate binary and a native host manifest. That gives up
the one thing an extension has and aria2 does not: it already holds the user's cookies and
session, so it can download the file behind a login that a standalone tool cannot see
(noted at `src/engine/probe.ts:62`).

**ffmpeg.wasm for TS->MP4 remuxing — deferred, with the socket left plugged in.** By the
specification, HLS fMP4 segments concatenated in order should yield a valid fragmented
MP4, and fMP4 is increasingly common in modern HLS — but no HLS download has ever run to
completion here, so no output file has been produced or opened. Both halves of that are
reasoning on paper. MPEG-TS segments are concatenated into a `.ts` file and the limitation
is stated to the user rather than hidden. A correct TS->MP4 muxer means parsing PAT/PMT,
unpacking PES, rebuilding SPS/PPS from Annex-B and generating `moov` tables — a project in
itself, and a rushed one produces silently broken files, which is worse than a `.ts` that
VLC and mpv are expected to open. So `src/engine/hls/assemble.ts` defines a `Remuxer`
interface with `registerRemuxer()`, and `planAssembly()` consults the registry, so filenames
and the download path upgrade themselves the day a real muxer is plugged in. Note that
`manifest/base.json` already allows `'wasm-unsafe-eval'` in the extension-pages CSP, so
policy is not the blocker. Nothing calls `registerRemuxer()` today.

**Separate video and audio renditions are two files, on purpose.** When a variant has a
separate audio rendition, `planMediaDownload()` returns two jobs and says so. Silently
returning one silent video file is the worst outcome, since the user only discovers it after
the download finishes (`src/engine/hls/index.ts:1135-1141`).

**DASH — recognised, not implemented.** `classifyMediaUrl()` detects `.mpd`, and
`planMediaDownload()` returns an explicit blocker rather than pretending.

**Static N-way split of the file — rejected**, see section 6.

**`SharedArrayBuffer` + `Atomics.wait` for the rate limiter — rejected**, see section 9.

**`HEAD` for probing — demoted to a fallback.** A single `GET` with `Range: bytes=0-0`
returns everything needed at once (206 proves Range support, `Content-Range` gives the total
size, and the remaining headers give the filename and validators). Plenty of CDNs block
`HEAD` or answer it inconsistently with `GET`, so `HEAD` is only used after a 416
(`src/engine/probe.ts:46-52`).

**The manager page as engine host — rejected.** Closing the tab would kill every download
(`src/engine/manager.ts:47`).

**Multiple writer workers — impossible**, see section 5.

## 15. Repository layout and commands

```
src/
  background/index.ts      Browser APIs, auto-mode interception, DNR rules, context menus
  offscreen/offscreen.ts   Chromium-only DOM host; implements HostBridge over runtime msgs
  platform/                api.ts (chrome/browser shim, offscreen bootstrap)
                           capabilities.ts (OPFS/sync-handle gate, checked before any write)
  engine/
    manager.ts             DownloadManager: owns jobs, queue, ThrottleServer, HeaderStore
    orchestrator.ts        DownloadJob: pieces, workers, retries, mirrors, finalisation
    pieces.ts              planPieces / takeNextPending / requeue
    probe.ts               One Range: bytes=0-0 GET, HEAD as fallback
    policy.ts              Auto-mode: what is worth intercepting
    storage.ts             OPFS parts directory, quota, blob URL handover
    throttle.ts            TokenBucket, ThrottleServer, ThrottleClient
    queue.ts               Concurrency cap and priorities
    schedule.ts            Download time windows via chrome.alarms
    persistence.ts         Checkpointing the piece map to storage.local
    recovery.ts            Deciding when resuming is safe, and when it is not
    filename.ts            Content-Disposition, RFC 5987, path safety
    host.ts                The HostBridge interface
    adaptive/
      concurrency.ts       ConcurrencyController (AIMD brake)
      headers.ts           Header classification, tiered replay, HeaderStore, DNR specs
      mirrors.ts           Fingerprints, content sampling, MirrorPool
      streaming.ts         Single-connection path for unknown-size responses
    hls/
      index.ts             HlsJob, media classification, playlist resolution
      playlist.ts          M3U8 parser
      keys.ts              AES-128 key fetch and decryption
      assemble.ts          OrderedSink, assembly planning, Remuxer plug point
    workers/
      fetch-worker.ts      One connection: Range GET, stream, throttle, forward to writer
      writer-worker.ts     The single OPFS writer
  ui/                      manager, popup, welcome, dom, a11y, format
  content/media-detect.ts  Detects media in pages
  shared/                  protocol (worker msgs), rpc (host msgs), settings, i18n, log
manifest/                  base.json + chromium.json + firefox.json overlays
scripts/                   build, test, bench, testserver, verify, make-icons
test/                      12 files, 457 tests
bench/bench.ts             Uses the real planner and controller
_locales/{vi,en}/          141 keys each; all 141 Vietnamese keys carry a description
```

Commands (Node 20+; esbuild targets node20, and the tests use `node:test` and global
`fetch`):

```
npm install
npm run build              # -> dist/chromium and dist/firefox (__DEV__=false, logging stripped)
npm run build:dev          # the same two targets, keeping [df:...] logging and sourcemaps
npm run build:chromium
npm run build:firefox
npm run watch              # implies --dev
npm test                   # 457 tests
npm run typecheck          # both tsconfigs
npm run testserver         # http://localhost:8787
npm run bench              # needs testserver running in another terminal
npm run verify <file>      # checks a downloaded file against the test pattern
npm run make-icons
npm run clean
```

`scripts/testserver.mjs` exposes `/file`, `/slow`, `/norange`, `/gzip`, `/named`, `/flaky`
and `/stats`. `/slow/<bytes>?kbps=N` throttles **each response separately**, which is the
condition multi-connection downloading is designed for. `/stats` returns
`{active, peak, totalRequests}` — connection counts only, no byte or rate counters.

## 16. If you want to contribute

The most valuable work is not new features. It is closing the gap between "passes 457 unit
tests" and "known to work".

Ranked by how much they would improve confidence:

1. **Run it in a browser and report what breaks.** Load `dist/chromium` unpacked, or
   `dist/firefox` via `about:debugging`. Nobody has done this. The README's 21-item checklist
   is the script.
2. **Test `DownloadJob`.** It is 815 lines of pure logic with every dependency already
   injected — `ThrottlePort`, `HeaderPort`, `JobEvents`, `PersistenceStore`. The reason it is
   untested is not that it needs a browser; `test/persistence.test.ts` already demonstrates
   the fake-port style this would use. This is the single largest confidence win available.
3. **Test `HlsJob`** (~574 lines) for the same reason.
4. **Extend typecheck to `test/` and `bench/`.** 6,129 lines currently type-unchecked.
5. **Make the Chromium service worker stop bundling the engine.** A dynamic `import()`
   behind the `isFirefox` branch in `background/index.ts`; measurable before and after with
   `ls -l dist/chromium/background.js`.
6. **Add a permission-request flow for Firefox MV3 host permissions.**
7. **Put the shared token bucket under the benchmark.** Section 9's design has never been
   measured.

Conventions that are load-bearing rather than stylistic:

- **Comments explain why, not what.** Most non-obvious lines in this codebase carry a note
  about the failure they prevent. Keep that up; those notes are the actual documentation.
- **Pure logic stays pure.** Injected clocks, injected ports, no direct browser API calls
  outside `background/` and `platform/`. This is why 457 tests can run in under a second
  with no network.
- **`src/engine/persistence.ts` must never import `platform/api`.** It would work on Firefox
  and fail silently on Chromium.
- **Prefer a loud failure to a quiet corruption.** Nearly every defensive branch in
  `mirrors.ts`, `recovery.ts`, `streaming.ts` and `assemble.ts` exists because the
  alternative was a file that opens but is wrong.
- **Both locales stay in sync.** 141 keys in `vi` and `en`; every Vietnamese key needs a
  `description`, and a test enforces it.
- **If you add a performance claim, add the measurement and the method with it.**

---

PolyForm Noncommercial licensed. Repository: https://github.com/baobao1044/down-faster
