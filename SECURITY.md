# Security Policy

## Project status

Down Faster is a personal project. Version 0.1.0 has never been listed on any store, and
the extension has never been loaded into a real browser — not on Chromium, not on Firefox,
not once. Correctness so far rests on 438 unit tests, a clean typecheck, and code review.
Read the rest of this file with that in mind.

Only the current default branch is supported. There are no released versions to backport
fixes to.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

**https://github.com/baobao1044/down-faster/security/advisories/new**

Please do **not** open a public issue for a security report. Public issues are fine for
everything else.

Useful things to include: the affected file and line, the browser and build target
(`dist/chromium` or `dist/firefox`), and the smallest reproduction you have — a URL shape,
a crafted response header, or a playlist snippet is usually enough.

### No response-time promise

This is one person working on a side project. I will not promise a triage window, a fix
deadline, or a disclosure timeline, because I cannot keep one, and a promise that gets
broken is worse than no promise. I read advisories and I will reply when I can. If you
need a guaranteed SLA, this is not the right project to depend on.

If you have not heard back and want to disclose publicly, you are free to do so. I would
appreciate a heads-up in the advisory thread first, but you owe me nothing.

## Scope

In scope:

- Leaking credentials (`Cookie`, `Authorization`, API-key headers) to an origin they were
  not captured from.
- Header or request injection through values the extension replays.
- Writing outside the download directory, or overwriting files, via a server-supplied
  filename.
- Script execution in the popup, manager page, or welcome page from server-controlled
  text (filenames, error strings, playlist fields).
- Escaping the extension's declared permissions, or getting the extension to fetch a URL
  the user never asked for.
- Anything that makes the extension send data to a third party. It currently sends none —
  see *Network surface* below.

Out of scope:

- Bypassing DRM. `assertSupported()` in `src/engine/hls/keys.ts` deliberately refuses
  Widevine, PlayReady, FairPlay, and `SAMPLE-AES`. That refusal is the intended behavior,
  not a bug to be worked around.
- Vulnerabilities in the servers you download from.
- Findings that require the user to install a modified build.
- Server load caused by parallel connections. That is the documented purpose of the
  extension and the connection count is user-configurable.

## Attack surfaces already considered

Each item below points at real code. Where a behavior is locked by a test I say so; where
it is only implemented and reviewed, I say that too.

### Header injection

`sanitizeHeaderValue()` (`src/engine/adaptive/headers.ts:123`) rejects any header value
containing `U+0000`–`U+001F` or `U+007F`, so a CR or LF cannot ride along into a replayed
header. It runs on both capture paths — `captureFromDownloadItem()` and
`captureFromRequestHeaders()` — and again inside `planReplay()` before a value reaches
`fetchHeaders`. `buildRuleSpec()` additionally refuses to build a `urlFilter` from a URL
containing anything outside printable ASCII, or the DNR metacharacters `* ^ |`, falling
back to a `requestDomains` match.

Honest limitation: no unit test currently asserts that a `\r\n` value is dropped. The
filter is reviewed code, not test-locked behavior.

### Credential leaks across origins

`SECRET_HEADERS` (`headers.ts:67`) covers `authorization`, `cookie`, `x-api-key`, and
`x-auth-token`. `planReplay()` compares the target origin against `capturedFrom` and drops
those headers whenever they differ — once on the `fetch` channel (`headers.ts:277`) and
again on the declarativeNetRequest channel (`headers.ts:315`). This matters most on
redirects to a third-party CDN.

Both directions are tested: `test/adaptive.test.ts:714` asserts the secrets are dropped
cross-origin, and `:735` asserts the cookie *is* sent when the origin matches — so the
guard cannot be satisfied by simply never sending anything.

`redact()` (`headers.ts:533`) masks secrets before anything reaches the console;
`test/adaptive.test.ts:901` asserts no fragment of the secret survives `JSON.stringify`.

### Server-supplied filenames

`sanitize()` (`src/engine/filename.ts:8`) strips everything up to the last path separator,
replaces control characters and `<>:"/\|?*`, removes leading dots and trailing dots or
spaces, prefixes Windows reserved device names, and caps the result at 200 characters.
`test/engine.test.ts:91-106` covers `../../etc/passwd`, absolute POSIX paths,
`C:\Windows\…`, the illegal-character replacement, and the reserved device names. Nothing
asserts the 200-character cap.

Filenames are rendered as text, never as markup. `src/ui/dom.ts` is built around that rule
and sets every string through `textContent`. A grep across all of `src/` finds zero uses of
`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, or
`new Function` — the only matches are the comments explaining why they are absent.
That module has no unit test of its own; the guarantee here is structural rather than
test-locked — there is no HTML sink in the codebase to inject into.

### Self-reclaim loops

When the engine gives a download back to the browser, it must not immediately grab it
again. `shouldIntercept()` (`src/engine/policy.ts:46`) refuses non-`http(s)` URLs (which
covers the `blob:` URL the engine itself just handed over), refuses items whose
`byExtensionId` equals this extension's own id, and refuses any URL in the `handedBack`
set — checking both the final URL and the pre-redirect URL.

Tested at `test/policy.test.ts:64`, `:69`, `:73`, `:83`, and `:88`.

## Data handling

**Captured headers live in RAM only.** `HeaderStore` (`headers.ts:447`) is a `Map` with a
TTL (10 minutes by default) and a 32-entry cap that evicts the oldest write first —
`lookup()` does not refresh recency, so it is insertion order, not true LRU. It is
constructed once in `src/engine/manager.ts:62` and is never serialized to
`chrome.storage` — nothing in `persistence.ts` writes a captured header. A cookie string
is a login secret; persisting it would turn a download tool into a credential store.

**No telemetry.** The count has to be taken with the right grep, because
`adaptive/streaming.ts` receives its `fetch` as an injectable dependency and a bare
`fetch(` search misses three of its call sites:

```bash
grep -rnE '\bfetch\(|fetchImpl\(' src --include='*.ts'
```

Thirteen lines come back, and two of them are not request sites: the comment at
`headers.ts:264`, and the wrapper at `adaptive/streaming.ts:151` —
`const globalFetch: typeof fetch = …`, which only forwards to the global `fetch` on
behalf of the call sites listed below, so counting it would count them twice. That leaves
**eleven** request sites. **Ten** go to a resource the user asked for: the file itself
(`probe.ts:58`, `probe.ts:92`, `fetch-worker.ts:97`, `orchestrator.ts:365`, and the
single-stream path at `adaptive/streaming.ts:445`, `:626`, `:674`), or — for HLS — the
playlist and its segments (`hls/index.ts:152`, `hls/index.ts:830`) and the AES key URI
that playlist names (`hls/keys.ts:207`). The eleventh, `src/shared/i18n.ts:303`, reads
`runtime.getURL('_locales/<locale>/messages.json')` — an extension-internal resource that
never leaves the browser. There is no `XMLHttpRequest`, `WebSocket`, `sendBeacon`, or
image beacon anywhere in the source. PRIVACY.md carries the same enumeration and the
stronger check against the built bundles.

**No remote code.** The content security policy in `manifest/base.json` is
`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. Nothing is loaded from a
network origin.

## Permissions

`host_permissions` is `<all_urls>` and the `media-detect` content script matches
`<all_urls>` in all frames, because a download can start from any site. On Firefox MV3
host permissions are optional and must be granted by the user; there is currently no
prompt screen for this, which is a usability gap rather than a security one.

`declarativeNetRequestWithHostAccess` is used only for `modifyHeaders` rules carrying the
captured headers `fetch()` is forbidden to set (`toDnrRule()`,
`src/background/index.ts:120`). Each rule is scoped to `tabIds: [-1]` (`headers.ts:381`) —
requests belonging to no tab, which is what the engine's offscreen and worker fetches
should be — and, when the target URL is ASCII-printable and free of `* ^ |`, pinned to
that exact URL with `|…|`. Ids come from a reserved span of 256 starting at
`RULE_ID_BASE = 720000` (`headers.ts:391`), so two replay rules cannot overwrite each
other. A DNR rule only ever applies to requests the registering extension can see, so
there is nothing to collide with from another extension.

## Known weak spots

Listing these is more useful than hiding them:

- **Never run in a browser.** Installing DNR rules, OPFS `createSyncAccessHandle`, the
  Web Workers, the offscreen document, `chrome.downloads`, and the content script have
  never executed. The pure logic feeding them is tested (`buildRuleSpec`,
  `RuleIdAllocator`, `shouldIntercept`), but no test reaches the code that makes the
  browser call: `src/background/index.ts`, both workers, `src/offscreen/offscreen.ts`,
  and `src/content/media-detect.ts` are imported by no test at all, and
  `src/engine/storage.ts` is pulled in only transitively — `recovery.ts` takes its
  `PartInspector` as an injected dependency, so the tests substitute a fake and never
  reach an OPFS call.

  The failure this makes most likely *is* guarded, and guarded early. `requireStorage()`
  (`src/platform/capabilities.ts:70`) runs at the top of `DownloadJob.openWriter()`
  (`src/engine/orchestrator.ts:457`), the one point every download path crosses before
  touching the disk. A browser with no OPFS — or with OPFS but no
  `createSyncAccessHandle` — fails there, naming the missing capability, instead of dying
  inside a worker several steps later; failing that early is also what leaves `fail()`
  able to hand the original URL back to the browser in auto mode. Four tests in
  `test/integration.test.ts` cover it, including that the probe runs once per session
  instead of creating and removing a probe file on every download. This is not an exotic
  case: OPFS is absent in the private-browsing mode of some browsers.
  `detectCapabilities()` itself is now driven by four tests with an injected fake
  storage, including the main-thread vs worker split; only the real `navigator.storage`
  call is still untested.

- **12 of the 41 files in `src/` — 2,820 lines — are not touched by any test, even
  indirectly.** Beyond those, `DownloadJob` (`src/engine/orchestrator.ts:153-967`) and
  `HlsJob` (`src/engine/hls/index.ts:518-1091`) are reached only through the modules
  around them and have no direct tests of their own. The pieces they coordinate are well
  covered; the coordination is not. Security-relevant logic that runs inside those two
  classes has not been exercised.
- **The control-character header filter is not test-locked** (see above).
- **`'wasm-unsafe-eval'` is declared but unused.** It is reserved for the `Remuxer` hook
  sketched at `src/engine/hls/assemble.ts:15`. Until something actually uses it, it is an
  unnecessary CSP relaxation and should be removed.
- **`test/` and `bench/` are not typechecked.** Both tsconfigs include only `src/**`, and
  the esbuild-based test runner erases types without checking them.

## Credit

If you would like to be credited in the advisory, say so in the report. Otherwise reports
stay anonymous.
