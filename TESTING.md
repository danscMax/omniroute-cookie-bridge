# Testing

## Offline checks

With Node.js, npm and the lockfile's development dependencies already installed,
run from the repository root:

```sh
npm test
npm run check
npm run build
git diff --check
```

`npm test` runs the source-reader, generator, catalog, rendering, background,
runtime, cookie-discovery, packaging and locale suites. These checks do not launch
a browser or contact a gateway or provider. TypeScript 6.0.3 is a development
dependency for the AST source reader; it is not packaged with the extension.

- `npm run test:source` checks static registry reading in disposable fixtures.
- `npm run test:generator` checks synthetic complete registries and reviewed
  capability evidence, without a real OmniRoute installation or global discovery.
- `npm run test:catalog` checks the shipped generated catalog and adapter.
- `npm run test:render` exercises the real popup under linkedom, including its
  directory. This is a DOM regression suite, not a browser or pixel check.
- `npm run test:bg` and `npm run test:runtime` exercise the worker and serialized
  page functions with synthetic browser/network surfaces.
- `npm run test:cookies` runs `test-cookie-discovery.mjs` against synthetic cookie
  API responses.
- `npm run test:build` builds disposable copies of the current runtime payload.
  It checks Chrome/Firefox manifests, byte preservation, runtime-only packaging,
  repeatable rebuilds, version agreement and portless loopback guards. Generation
  is tested separately; packaging never needs upstream sources or global installs.
- `npm run test:i18n` checks shipped locale keys.

Popup transport regressions verify callback-time consumption of
`runtime.lastError`, explicit transport/unreachable outcomes for lost replies,
no replay of writes and no false-green aggregate results.

Temporary offline fixtures are removed afterward. Set `BRIDGE_TEST_TMPDIR` to an
existing temporary parent directory to choose their location. Otherwise packaging
fixtures use Node's portable OS temporary directory (`os.tmpdir()`).

`npm run check` syntax-checks runtime, generator and test scripts.
`npm run build` replaces `build/chrome/` and `build/firefox/` with runtime-only
packages. Generator modules, TypeScript, the coverage report, tests, documentation
and test artifacts are excluded. Invalid version or required loopback permissions
fail before existing packages are replaced.

### Catalog baseline

The committed catalog is pinned to OmniRoute
`e3c1531afd07d5e06f7ffab658584a7ae2e3627e`: 394 distinct directory entries across ten sections,
37 web entries, 313 API-key entries, 32 OAuth entries and 24 entries in the residual
`other` directory view. The onboarding lists overlap; their counts must not be
summed as if they were disjoint. Dashboard-required providers also appear in the
web, API-key and OAuth lists, so `other` is not their total. Regeneration is a
separate, explicit operation against a chosen source checkout/ref; offline
packaging uses the already-generated payload.

The reviewed web modes are 15 Cookie, 6 Bearer-token and 16 dashboard setups.
Language-model providers use `llm` in `serviceKinds` and are chat-probe eligible.
Model selection retains `type` and `supported_endpoints` from `/v1/models` and
skips explicitly non-chat or Responses-only models.

### Cookie discovery bounds

When `chrome.cookies.getAll` returns a list without a complete usable candidate—
including an empty, analytics-only or incomplete list—the fallback uses
`chrome.cookies.get` for the reviewed recipe's required names at the same exact
capture URL and selected store. It first tries the whole name; if its value is
absent or empty, it checks `.0`. A missing `.0` ends that name's chunk search.
With a nonempty `.0`, it checks through `.16`, even after a missing suffix: only
contiguous, nonempty chunks `.0`–`.15` are accepted (at most 16), and `.16` must be
absent as an overflow guard. Gaps, empty chunks or failed/timed-out reads reject
that name's cookie family; other reviewed alternatives remain eligible within
the scan budget. A candidate must still satisfy every required cookie group.
This can recover parent-domain sessions while keeping
manifest permissions and request matchers on exact hosts. The selected credential
comes from either a complete enumerated candidate or a separate complete named
candidate; enumeration and named results are never merged.

Named lookups omit `partitionKey`; Chromium also omits `firstPartyDomain`, while
Firefox passes `firstPartyDomain: ""`. The fallback uses the default unpartitioned
context; results with nondefault partition/first-party metadata are rejected.
Candidates never combine different capture URLs, stores or first-party/partition
contexts. Cookie queries share a 4-second scan budget, with at most 800 ms per
query. Passive discovery uses at most four workers and eight selected stores per
provider. Duplicate queries within a scan are coalesced, and late results are
ignored. These limits do not cover every browser store or partition. The focused
`test-cookie-discovery.mjs` suite uses synthetic cookies for the fallback,
required groups, context separation, chunks and deadlines.

## Opt-in isolated browser suite

Use an already-installed, extension-capable Chromium executable and a local
Playwright package directory. The runner neither installs nor discovers them.
Build after source changes, then supply explicit local paths:

```sh
node test-browser.mjs --help
npm run test:browser -- --executable "/path/to/chromium" --playwright "/path/to/node_modules/playwright" --output "/path/to/existing-parent/new-bridge-run" --package "build/chrome"
```

`--executable`, `--playwright` and `--output` are required. The output directory
must not exist, its parent must exist, and it must be outside every Git checkout.
Every launch creates a new profile beneath that directory; no existing browser
or personal profile is used. The runtime payload is snapshotted and hashed before
loading. `--extension "/path/to/extension"` selects another runtime source;
`--package` adds a rebuilt Chrome-package smoke. Only runtime files, icons and
locales enter these snapshots. `--help` performs no service or browser startup.

The isolated popup opener uses `context.newPage()` and `page.goto()` to open
exactly one runner-owned page at the installed extension's `chrome-extension://`
popup URL. Page creation and navigation are bounded. Startup asserts the runtime
ID and exact URL and requires a bounded native `getSettings` response. Packaged
smoke retains the `ping.ok`, nine-pane and 394-entry directory assertions.

The terminal HTTP proxy generates synthetic responses and never forwards traffic.
Unmodeled HTTP requests and all HTTPS CONNECT requests are denied. Before loading
the extension, the preflight verifies page and extension-worker traffic traverse
the proxy, then verifies both fail closed when it is unavailable. A direct sentinel
must receive no requests during preflight or the feature run. The fixture supplies
synthetic sessions, keys, OAuth responses, imports and chat; it does not impersonate
a real account or validate live provider credentials. Fixture pages also receive
a synthetic `/favicon.ico` response.

### Browser scenarios

- Nine panes, including the full 394-entry directory; exact category filtering,
  global search, source guidance/links and dashboard-only setup actions.
- Existing HttpOnly cookies: canonical Perplexity
  `__Secure-next-auth.session-token`, Clerk's distinct request host, an accepted
  Blackbox cookie alternative, and Grok's complete `sso` plus `sso-rw` group.
  Native `getAll`/`get` comparisons cover Perplexity's parent-domain session and
  Gemini's `.google.com` session with nonempty, analytics-only enumeration, using
  exact app-host permissions. A parent-domain Perplexity `.0`/`.1` session is
  reconstructed and imported, then restored to a whole cookie in the same slot.
  Perplexity imports send the named value and update the remembered account slot.
  Declared and granted permissions cover both request and initiator hosts without
  widening request matchers; dashboard-only entries have no capture permissions.
- API-key add/update, required Google PSE `cx`, PSE bulk exclusion, and Cloudflare
  `accountId` forwarding on every bulk entry; numeric partial/failure results.
- GitHub device-code progress/backoff/cancel and explicit connection IDs on success.
  Codex callback receipt remains pending until `POST /poll-callback` consumes it;
  same-account re-auth succeeds with an unchanged connection count. A missing
  callback server produces a terminal error. Asynchronous message/storage checks
  use bounded runner-side polling outside `waitForFunction`, awaiting each result
  before testing readiness.
- Devin CLI's supported raw-token import, blocked Cursor generic/automatic import,
  its explicit dashboard handoff, dashboard-only web/key imports, rejected generic
  credential blobs, and synthetic ZIP outcomes. The fixture offers no automatic
  local-credential or arbitrary credential-blob success path. Import responses
  are observed across the browser context because writes run in the dashboard tab.
- Gateway auth/failure/deadlines, models/chat/probes, connection management,
  secret-free roster export, settings, worker restart, sizing and locale rendering.

Results go to `feature-results.json`, with `isolation.json`, `network.json`,
screenshots, snapshots and hashes alongside it. A blocked run or failed feature
returns a nonzero exit status. A final feature check, after all browser contexts
close, fails on uncaught `pageerror` exceptions and unexpected context-console
errors or failed assertions. Warnings remain recorded diagnostics. Browser-native
resource errors are exempt only for the fixture's recorded CONNECT denials,
deliberate gateway disconnects/hangs/401 responses, or the proxy-down preflight
URLs; JavaScript `console.error()` calls and page exceptions are never exempted
by network-error wording. Reports record actual start/finish timestamps and
per-feature outcomes; documentation does not assert that a run has passed.

### Limits and skips

- Live provider sign-in, upstream token exchange, external authenticated XHR
  capture, quota/billing and Firefox/container or partitioned-cookie behavior are
  deliberately skipped.
  The browser suite is Chromium plus synthetic route contracts; offline tests
  cover the broader recipe/credential cases.
- Worker restart is covered; cold browser restart is skipped.
- Native toolbar popup negotiation is skipped if Playwright cannot expose its
  target. Full-tab and `window=1` rendering do not verify native window chrome.
- Packaged startup is skipped when `--package` is omitted. A Firefox package
  manifest is checked offline; that does not establish a Firefox browser pass.

Use each report's per-feature status and skip reason as the record of that run.
