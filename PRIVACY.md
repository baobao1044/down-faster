# Privacy

Down Faster asks for `<all_urls>` and sends your cookies to the servers it downloads
from. Those are two of the strongest things a browser extension can ask for, and you
should not take anyone's word about them — including mine.

So this document is written to be checked, not believed. Every claim below names the
file and line it comes from, and the sections that matter most come with a command you
can run yourself against this repository. Where I cannot prove something, I say so
instead of rounding it up.

**Status, stated up front:** this extension has never been run in a real browser. Not
once. The claims here are about what the source code does and what the built bundles
contain — both of which you can verify — not about observed runtime behaviour. See
[What this document cannot promise](#what-this-document-cannot-promise).

---

## The short version

- No analytics, no telemetry, no crash reporting, no remote config, no "anonymous usage
  statistics". There is no server to send anything to, and the built bundle contains
  zero hardcoded `http://` or `https://` URLs.
- The extension never reads your cookies. It asks the *browser* to attach them, which
  is a different thing — [explained below](#cookies-and-credentials-include).
- Downloads in progress are written to `chrome.storage.local`: URL, filename, and a
  byte map. Kept 7 days, capped at 50 records.
- Captured `Referer` / `Origin` live in RAM only, with a 10-minute TTL. They are never
  written to disk.
- Partial file data lives in OPFS (the browser's private on-disk sandbox) and is deleted
  when the download finishes or is cancelled.

---

## Permissions, one at a time

Every permission below is in `manifest/base.json` (plus `offscreen` for Chromium in
`manifest/chromium.json`). Nothing is requested "just in case".

| Permission | What it is used for | Where |
|---|---|---|
| `downloads` | Hand the finished file to the browser's download manager; cancel a browser download when the engine takes it over; erase the cancelled stub so it does not sit in your download list as a failure | `src/background/index.ts:61`, `:72`, `:347-348` |
| `storage` | Store your settings, and the resume map for downloads in progress | `src/shared/settings.ts:75,94`, `src/engine/persistence.ts` |
| `unlimitedStorage` | Raise the OPFS quota so a large partial file is not evicted mid-download. No API call — it only changes the quota the browser grants | quota read at `src/engine/storage.ts:61` |
| `contextMenus` | The "download with Down Faster" right-click entry | `src/background/index.ts:390-401` |
| `notifications` | Tell you a download finished or failed | `src/background/index.ts:89` |
| `alarms` | Wake the extension at the start and end of a scheduled download window. A 15-minute heartbeat runs only while a window is closed, because a browser update can drop an alarm and leave you waiting for a download that never starts | `src/engine/schedule.ts:216-218`, `:300-308`, `src/background/index.ts:170-172` |
| `declarativeNetRequestWithHostAccess` | Set `Referer` / `Origin` on the extension's *own* requests, which `fetch()` is forbidden from doing — see [declarativeNetRequest](#declarativenetrequest-what-the-rules-actually-do) | `src/background/index.ts:133-149` |
| `offscreen` (Chromium only) | Host the download engine. An MV3 service worker has no DOM, cannot spawn a `Worker`, and cannot create a blob URL, so the engine cannot live there | `src/platform/api.ts:46-60` |

Permissions this extension does **not** request, and you can confirm their absence in
the manifest: `cookies`, `webRequest`, `webRequestBlocking`, `history`, `bookmarks`,
`tabs`, `identity`, `management`, `browsingData`, `scripting`, `debugger`, `proxy`.

```bash
grep -rnE '\b(cookies|webRequest|history|bookmarks|identity|management|browsingData|scripting|debugger|proxy)\.' src/ --include=*.ts
```

That command returns exactly one line — a code comment in
`src/engine/adaptive/headers.ts:154` describing a `webRequest` capture path that was
considered and **not** built. No call sites.

One clarification before you find it yourself: `chrome.tabs` *is* called, at
`src/background/index.ts:322`, `:411`, `:442` and `src/ui/popup.ts:105`, `:206`. None of
those needs the `tabs` permission — opening a tab and hearing that one closed are free
— and the one query that could have read page data reads only `tab.id`, never `tab.url`
or `tab.title` (`src/ui/popup.ts:105-106`).

### Why this asks for `<all_urls>`

The honest answer, and not a comfortable one: an extension whose entire job is
downloading files cannot know in advance which host you will download from.

A download accelerator has to issue HTTP requests to whatever URL you click, and there
is no list of hosts that would be right for anyone but the person who wrote it.

An extension *can* ask for hosts at runtime rather than at install time —
`optional_host_permissions` plus `chrome.permissions.request()` — so let me be exact
about why this extension does not. That call has to happen inside a user gesture. It
would fit the popup and the right-click entry. It does not fit the path that matters
most: automatic mode takes a download over from `downloads.onCreated`
(`src/background/index.ts:335`), which fires when the *browser* starts a download, with
no click of the extension's own to hang a prompt on. By the time a permission dialog
could be answered, the download it was about has already gone somewhere.

Say the rest of that out loud, because it is the part you would want told: automatic mode
is **on by default**. `DEFAULT_SETTINGS.autoMode` is `true` (`src/shared/settings.ts:51`),
so from the moment you install, this extension takes over every http/https browser
download of 5 MiB or more (`minInterceptSize`, `:53`) without you clicking anything — and
also any download whose size the browser has not yet reported, whatever that size turns
out to be, because the gate only rejects a download it already knows to be small:
`item.fileSize > 0 && item.fileSize < ctx.minSize` (`src/engine/policy.ts:62`). The
toggle that turns it off is the first control in the popup (`src/ui/popup.ts:45`) and on
the welcome screen you see at install (`src/ui/welcome.ts:16`).

So this asks for `<all_urls>` at install time. A per-site flow for the click-driven
paths is buildable and is not built — that is a decision I made, not a limit the
platform imposed, and you should weigh it as one.

What `<all_urls>` grants here, concretely:

1. **`fetch()` to any origin with credentials.** This is the actual download. Every
   network request in the codebase targets a URL you supplied, with exactly one
   internal exception — see
   [No telemetry](#no-telemetry-and-how-to-check-that-yourself).
2. **A content script on every http/https page.** This comes from the separate
   `<all_urls>` entry under `content_scripts` in `manifest/base.json`, and it exists only
   to spot `<video>` sources and `.m3u8` / `.mpd` URLs so the popup can offer them. See
   [The content script](#the-content-script).
3. **declarativeNetRequest header rules.** Scoped to `tabIds: [-1]`, which means
   requests that belong to no tab — the extension's own. See
   [declarativeNetRequest](#declarativenetrequest-what-the-rules-actually-do).

On Firefox MV3, host permissions declared in the manifest are treated as optional and
must be granted by you after install. This extension currently has no screen that
prompts for them, which is a real gap listed in the README. I have not verified Firefox's
behaviour here directly — the extension has never been run in Firefox.

---

## No telemetry, and how to check that yourself

There is no analytics endpoint, no error reporting service, no remote configuration
fetch, no update ping, no "share anonymous data" toggle that quietly defaults to on.

Rather than assert it, here are the commands. Run them in the repository root.

**1. Every network primitive that is not `fetch`:**

```bash
grep -rnE 'XMLHttpRequest|WebSocket|sendBeacon|new Image\(|EventSource' src/ --include=*.ts
```

Returns nothing. There is no second channel.

**2. Every network call site in the source:**

```bash
grep -rnE '\bfetch\(|fetchImpl\(' src/ --include=*.ts
```

Thirteen lines come back, and two of them are not request sites: a code comment at
`src/engine/adaptive/headers.ts:264`, and the `typeof fetch` default-wrapper declaration
at `src/engine/adaptive/streaming.ts:151`. (`streaming.ts` takes its `fetch` as an
injectable dependency so the tests can substitute one, which is also why a bare `fetch(`
grep alone would miss three of its call sites — grep for `fetchImpl(` too, as above.)

That leaves **twelve** places that issue a request. Eleven of them take a URL that came
from you — the file you asked for, a mirror URL you entered, an HLS playlist, or a segment
listed inside that playlist:

- `src/engine/probe.ts:63`, `:123`, and `:155` — the one-byte range probe that discovers file
  size, its `HEAD` fallback, and its plain-GET fallback for transport-compressed responses
- `src/engine/workers/fetch-worker.ts:97` — the byte-range requests that are the download
- `src/engine/orchestrator.ts:365` — reads a byte range from a candidate mirror to check
  it is genuinely the same file before trusting it
- `src/engine/adaptive/streaming.ts:445`, `:626`, `:674` — the single-stream path for
  servers that do not report a size, its size probe, and its resume check
- `src/engine/hls/index.ts:152` and `:834` — playlist and segment
- `src/engine/hls/keys.ts:207` — the AES-128 key URI, which comes from the playlist

The twelfth is the only exception, and it never leaves your machine:

```js
// src/shared/i18n.ts:299 and :303
const url = runtime?.getURL?.(`_locales/${locale}/messages.json`);
if (!url) return false;
const response = await fetch(url);
```

That is a `chrome-extension://` URL pointing at a translation file inside the extension's
own package. The locale string is validated against `/^[a-z]{2}(_[A-Z]{2})?$/`
(`src/shared/i18n.ts:271`) before it is used, so it cannot be steered elsewhere.

> **Note on the ad network fetch:** `src/ui/ads.ts` can issue a `fetch` to a configured ad
> endpoint, but it calls through a local variable (`const f = fetchImpl ?? fetch`) so it
> does not appear in the grep above. It is **disabled by default** — see the
> [Ad networks](#ad-networks) section. When disabled, no request is made.

**3. The strongest check — grep the built output, not the source:**

```bash
npm run build
grep -ohE 'https?://[a-zA-Z0-9._~:/?#@!$&*+,;=%-]+' dist/chromium/*.js dist/firefox/*.js | sort -u
```

One result: `https://github.com/baobao1044/down-faster`. That is the house-ad
link (see the [Ad networks](#ad-networks) section) — a static link to the project's
own GitHub page, used as a plain `<a href>` when the ad card renders. It is not a
network endpoint; no request is made to it. Every other URL the extension ever
contacts arrives at runtime from you.

**4. The dependency surface:**

`package.json` lists three devDependencies (`esbuild`, `typescript`, `@types/chrome`)
and **no runtime dependencies at all**. Nothing is bundled that I did not write, so
there is no third-party SDK that could be phoning home behind my back.

### One thing that does write output: the console

`src/shared/log.ts` writes to the browser console. `log()` is compiled out of release
builds: the default `npm run build` sets `__DEV__` to `false`, so esbuild drops every
`console.log` call from the output — build with `npm run build:dev` if you want them
back. `warn()` always prints. `error()` is exported (`src/shared/log.ts:15`) but nothing
in `src/` ever imports it, so no built bundle contains a single `console.error`:

```bash
grep -cE 'console\.(log|error)' dist/chromium/*.js dist/firefox/*.js
```

Zero for every file; the only console output that survives a release build is
`console.warn`. This is your local devtools console only — nothing is
transmitted. Secrets are masked before they can reach it: `redact()`
(`src/engine/adaptive/headers.ts:533`) replaces `Cookie` and `Authorization` values with
a placeholder and a length, and there is a test named *"redact che Cookie và
Authorization trước khi log"* that keeps it that way. (Test names in this project are
written in Vietnamese; they are quoted verbatim here so you can grep for them in
`test/`.)

---

## What is stored, where, and for how long

| Data | Location | Lifetime | Code |
|---|---|---|---|
| Settings (connection count, speed limit, schedule windows, toggles) | `chrome.storage.local`, key `settings` | Until you change or uninstall | `src/shared/settings.ts:73-95` |
| Resume records — the whole shape is `PersistedTask` at `src/engine/persistence.ts:52`, so you can check this list against it: task id, how the download started, original URL, final URL after redirects, filename, MIME type, size, whether the server accepts ranges, ETag, `Last-Modified`, state, bytes received, a per-piece byte map, and created/updated timestamps | `chrome.storage.local`, keys prefixed `df:task:` | Deleted when the download completes or is cancelled. Otherwise purged after **7 days**, and only the newest **50** records are kept | `src/engine/persistence.ts:159-160`, `selectStale()` at `:506` |
| Partial file data | OPFS, `parts/<task-id>.part` | Deleted on completion or cancel (`removePart`); orphans swept at startup by `cleanupOrphans()` | `src/engine/storage.ts:26-33`, `:67-88` |
| Captured `Referer` / `Origin` for a URL. The record also has `userAgent` and `cookie` fields, but nothing in the shipped build ever fills them — [see below](#the-cookie-code-that-exists-but-is-not-wired-up) | **RAM only** | 10-minute TTL, max 32 entries, evicted oldest-first | `src/engine/adaptive/headers.ts:447-455` |
| Media candidates found on a page (URL, kind, how it was spotted, a label taken from the page title, duration, dimensions) plus the page URL and page title | **RAM only**, in the background script, keyed by tab id | Deleted when you close the tab; capped at 24 per tab | `src/background/index.ts:53`, `:302`, `:322` |

Be clear-eyed about row two: **the URL and filename of every download in progress are
written to disk.** That is browsing-adjacent data. It is the price of being able to
resume a 4 GB download after a browser crash, and it is bounded — 50 records, 7 days,
gone the moment the download finishes. If that trade is not one you want, the resume
feature is what you would need to give up.

### The header store never touches disk

This is deliberate, and the code says so in a comment above the class
(`src/engine/adaptive/headers.ts:441-445`): storing a cookie string in
`chrome.storage.local` would turn a download utility into a credential store. So
`HeaderStore` is a plain in-memory `Map` with a TTL. It has no `chrome.storage` import,
no serialization path, and no way to persist. Two tests pin the behaviour:
*"HeaderStore quên theo TTL và đuổi mục cũ nhất khi đầy"* and
*"HeaderStore khớp chính xác trước, rồi mới lui về cùng thư mục"*.

---

## Cookies and `credentials: 'include'`

Every download request uses `credentials: 'include'` — ten call sites, findable with:

```bash
grep -rn "credentials: 'include'" src/ --include=*.ts
```

(Eleven matches; one of them, `src/engine/hls/playlist.ts:11`, is a code comment.)

**Why.** Files behind a login only download if the request carries your session. Without
credentials, a download from a paid course, a private file host, or a logged-in web app
returns 403, and the extension would be useless for exactly the downloads where waiting
hurts most. This is the one advantage a browser extension has over `aria2` or `curl`
running outside the browser, and giving it up would remove the point of building this
inside a browser at all.

**What it actually means.** `credentials: 'include'` tells the browser: *attach the
cookies you already hold for this destination.* The browser does the attaching. The
cookie header is added below the JavaScript layer, in the network stack.

**What that means for you, precisely:**

- The extension **cannot read** the cookies being sent. `Cookie` is a forbidden request
  header for `fetch`, and `Set-Cookie` is a forbidden response header. Both are
  invisible to extension JavaScript. To be clear about where that guarantee comes from:
  it is the Fetch specification's forbidden-header rule, enforced by the browser. No
  code in this repository implements it and no test here proves it.
- The extension **has no `cookies` permission**, so it cannot read them the other way
  either. `grep -rn 'cookies\.' src/` returns nothing.
- Cookies are sent **only to the URL you are downloading from**, following the browser's
  own origin rules. There is no code path that moves a credential from one host to
  another.
- A download request carries the same credentials your browser would have sent had you
  clicked the link normally. It does not create access you did not already have.

### The cookie code that exists but is not wired up

If you grep for `cookie` in `src/`, you will find `SECRET_HEADERS`, a `cookie` field on
`CapturedHeaders`, and a tier-3 branch in `planReplay()` that would replay a captured
`Cookie` header. I would rather tell you about it than have you find it and wonder.

Here is the state of it: the only function that can ever populate that field is
`captureFromRequestHeaders()` (`src/engine/adaptive/headers.ts:155`), and it needs
`webRequest.onBeforeSendHeaders` to feed it. Check who calls it:

```bash
grep -rn 'captureFromRequestHeaders' src/ --include=*.ts
```

One hit: the definition itself. **Nothing calls it.** The `webRequest` permission is not
in the manifest. The only capture path that actually runs is
`captureFromDownloadItem()` (`:135`), which reads the `referrer` field of a download item
and has no access to cookies at all — the comment there says so explicitly.

So in the shipped build, `captured.cookie` is always `null` and the tier-3 cookie branch
is unreachable. It is dead code kept behind a tested guard rather than deleted, and the
guard is strict: `planReplay()` will only ever emit a `Cookie` header when the target
origin exactly matches the origin it was captured from. Two tests enforce it —
*"planReplay không bao giờ gửi bí mật sang origin khác nơi thu được"* and
*"planReplay gửi Cookie khi và chỉ khi đúng origin đã thu được"*.

If a future version wires up `webRequest`, that will require a new permission, which
means a new install prompt. You will see it.

### The response headers the extension reads

Nine, and you can list them yourself with
`grep -rn 'headers.get(' src/ --include=*.ts`:

`accept-ranges`, `content-disposition`, `content-encoding`, `content-length`,
`content-range`, `content-type`, `etag`, `last-modified`, `retry-after`.

That is the complete set. Every one of them is needed to split a file into byte ranges,
name it, and back off when a server pushes back.

---

## declarativeNetRequest: what the rules actually do

Some links only work when the request carries the `Referer` of the page that produced
them. `fetch()` cannot set `Referer` — it is a forbidden request header. The `referrer`
option is not a way around it either: it accepts only a same-origin URL, the empty
string, or `about:client`, and a cross-origin value is silently downgraded to "client",
which for an extension is a `chrome-extension://` URL. The end result is that the
browser sends no `Referer` at all. Setting `referrer` from an extension is a silent
no-op. The long comment at the top of `src/engine/adaptive/headers.ts` documents this
in detail.

declarativeNetRequest is the only remaining way to set that header. Here is exactly how
it is used.

**When a rule is installed.** Not on install, and not at the start of a download. The
replay tier starts at 0 (`src/engine/orchestrator.ts:173`), and tier 0 installs nothing.
The tier only escalates when a server answers **401, 403, or 451** — `nextTier()` at
`headers.ts:334` returns `null` for every other status. Referer/Origin rules are tier 2.
A download that works normally never installs a rule at all.

**What a rule can affect.** Every rule is built with `tabIds: [-1]`
(`headers.ts:381`), which restricts it to requests that belong to no tab — that is, the
extension's own requests. It cannot modify a request made by a page you are browsing.
The URL filter is pinned with `|…|` for an exact match on the download URL, and falls
back to a single `requestDomains` entry only when the URL contains characters that are
special in DNR filter syntax (`buildRuleSpec()` at `:363`).

**What a rule can contain.** Only headers from `plan.networkHeaders`, which `planReplay()`
restricts to `referer` and `origin` at tier 2, plus `user-agent` and `cookie` at tier 3.
In the shipped build neither tier-3 header is reachable. The only thing that ever fills
the store is `captureFromDownloadItem({ url, referrer: pageUrl })` at
`src/engine/manager.ts:154`, called without the optional `userAgent` argument, so
`captured.userAgent` and `captured.cookie` are both permanently `null`. A rule can
therefore only ever carry `referer` and `origin`. Header values are rejected if they
contain control characters (`sanitizeHeaderValue()` at `:123`), so nothing can be
smuggled in by injecting a newline.

**When a rule is removed.**

1. When the download ends — `disarmRules()` (`src/engine/manager.ts:142`) removes the id
   as soon as the task releases it.
2. At every startup — `bootstrap()` (`src/background/index.ts:459`) calls
   `applyHeaderRules({ add: [], removeIds: allRuleIds() })`, wiping the extension's
   entire reserved id range (`720000`–`720255`) before doing anything else. The comment
   there explains why: a stale rule attaching a wrong `Referer` to a new request is a
   miserable bug to track down.
3. By the browser — these are **session** rules (`updateSessionRules`), not dynamic
   rules. They do not survive a browser restart even if the extension crashes.

Rule ids come from a fixed 256-slot allocator that throws rather than recycling a live
id, so one download cannot silently overwrite another's rule (`RuleIdAllocator` at
`headers.ts:401`).

---

## The content script

`media-detect.js` is declared with `"matches": ["<all_urls>"]` and `"all_frames": true`
(`manifest/base.json`, `content_scripts`), so the browser injects it into every frame it
is willing to inject into at all — the script itself, not the manifest, is what narrows
that to http/https. It exists so the popup can offer you the video
on the page you are watching.

What it does:

- Bails out immediately on anything that is not http/https
  (`src/content/media-detect.ts:64`).
- Watches for `<video>` / `<source>` elements and uses `PerformanceObserver` to notice
  `.m3u8`, `.mpd`, and direct media URLs the page loads. It deliberately does not run a
  `MutationObserver`, both for cost and because MSE players expose only `blob:` URLs
  anyway.
- Sends the background script a batched list containing the media URLs it found, plus
  `location.href` and `document.title` for labelling (`:161-165`). Capped at 64 items
  per frame.

What it does not do: it does not read page text, form fields, or anything a user typed.
It has no network access of its own — it holds no `fetch` call, and its only outbound
path is `runtime.sendMessage` to this extension's own background script. The result is
held in a RAM `Map` keyed by tab id and deleted when the tab closes
(`src/background/index.ts:322`).

It is on by default: `DEFAULT_SETTINGS.detectMedia` is `true`
(`src/shared/settings.ts:66`), so this script starts running on every http/https page
from the moment you install, without you switching anything on.

You can turn it off — the toggle is in the manager page's settings
(`src/ui/manager.ts:505`). Setting `detectMedia` to false makes the script tear itself
down — disconnect observers, clear its buffers, remove its listeners — rather than
merely staying quiet (`honourSetting()` at `src/content/media-detect.ts:234`).

---

## What this document cannot promise

This is where the honest boundary sits, and it matters more than anything above.

**The extension has never been run in a browser.** No Chrome, no Firefox, not once. The
development machine has no browser installed. Everything in this document is a claim
about source code and build output — both of which you can inspect and verify — not
about observed behaviour. The 438 automated tests (`npm test`) run under `node:test` and
cover pure logic; they cannot exercise OPFS, Web Workers, the offscreen document,
`chrome.alarms`, `chrome.downloads`, or declarativeNetRequest, because none of those
exist outside a browser.

Specifically, these privacy-relevant claims are verified **by reading code and greps**,
and not by watching a real browser:

- That declarativeNetRequest rules are actually removed by
  `updateSessionRules({ removeRuleIds })` on this browser version. The rule *specs* are
  tested (`buildRuleSpec`, `RuleIdAllocator`); the *installation* has never run.
- That `tabIds: [-1]` is honoured as documented on both Chromium and Firefox.
- That OPFS temp files are actually deleted by `removeEntry`. The delete calls are
  there; no filesystem has ever seen them.
- That `chrome.storage.local` records are purged on the schedule described. The purge
  logic is unit-tested against a fake store, not against a real `storage.local`.

Also worth knowing about the code behind these claims, measured with esbuild's metafile
rather than estimated: of the 41 TypeScript files in `src/`, **12 — 2,820 lines — are
reached by no test at all, not even indirectly**. `src/engine/manager.ts` (614 lines) is
one of them, and it is the file that owns `armRules()`, `disarmRules()` and two
`storage.removePart()` calls. Two more files are weaker than a file-level count suggests:
`src/engine/orchestrator.ts` and `src/engine/hls/index.ts` are pulled into test runs
indirectly, but the classes that matter here — `DownloadJob` and `HlsJob`, which hold
most of the `storage.removePart()` calls — have no test of their own. The individual
pieces are tested; the code that wires them into a real download is not. The README
carries a 21-item manual test checklist that exists precisely to close this gap, and it
has not been run.

**No one outside the author has used this.** It is not on any extension store, has had
no external review, and has had no security audit.

If you find a claim in this document that the code does not support, that is a bug and I
want to hear about it — open an issue at
<https://github.com/baobao1044/down-faster/issues>. A privacy document that turns out to
be wrong is worse than no privacy document.

---

## Ad networks

The popup and the manager page show a small ad card. The disclosure here is required by
the Chrome Web Store ad policy.

**This release (0.3.0) — house ad only, no network.** The card shows static content
pointing at the project's own GitHub page. The only hardcoded URL in the bundle is
`https://github.com/baobao1044/down-faster`, used as a plain `<a href>`. **No network
request is made** to display it — the creative is embedded in the code. Clicking it opens
the GitHub page in a new tab.

**Network ad provider — disabled by default.** The code is architecture-ready to fetch
ad creative (text, image, link) from a configured endpoint via `fetch` with
`credentials: 'omit'` — no cookies, no tracking identifiers are sent to the ad endpoint.
The default config (`DEFAULT_ADS_CONFIG` in `src/ui/ads.ts`) has `networkEnabled: false`
and no endpoint set. If a future release enables it, the ad endpoint domain will be
disclosed in this section *before* that release ships.

**What the ad code does not do:**

- No `<script>` injection — the creative is fetched as JSON and rendered with
  `textContent` only (CSP `script-src 'self'` forbids remote scripts anyway).
- No `innerHTML` — the DOM helper (`src/ui/dom.ts`) never writes raw HTML.
- No cookie, no fingerprint, no identifier sent to any ad endpoint.
- No ad network SDK is bundled.

---

## Changes to this document

This file is versioned in the repository. Its history is the changelog — `git log
PRIVACY.md` shows every revision and what it changed. If the data handling described
here ever changes, the commit that changes the code and the commit that changes this
file should be the same commit.

---

Down Faster is PolyForm Noncommercial licensed. Author: BaoBG (<baobg104@gmail.com>),
<https://github.com/baobao1044/down-faster>.
