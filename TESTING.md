# Testing

## Offline checks

With Node.js, npm and the lockfile's development dependencies already installed,
run these commands from the repository root:

```sh
npm test
npm run check
npm run build
git diff --check
```

`npm test` runs the catalog, rendering, background, runtime, packaging and locale
checks. It does not launch a browser or contact a gateway or provider.
`npm run test:build` runs only the packaging regressions: disposable source copies
and synthetic registries exercise generation, clean Chrome/Firefox builds,
portless loopback permissions, version agreement and source preservation.
Temporary fixtures are removed afterward; `BRIDGE_TEST_TMPDIR` can select an
existing temporary parent directory instead of the OS default.

`npm run check` syntax-checks the extension and packaging/browser-test scripts.
`npm run build` emits runtime-only packages in `build/chrome/` and
`build/firefox/`; the development scripts and test artifacts are excluded.

## Opt-in isolated browser suite

Use an already-installed, extension-capable Chromium executable and a local
Playwright package directory. Playwright and Chromium are supplied explicitly;
the runner does not install or discover them. Run after building, replacing the
generic paths below with local paths:

```sh
npm run test:browser -- --executable "/path/to/chromium" --playwright "/path/to/node_modules/playwright" --output "/path/to/existing-parent/new-bridge-run" --package "build/chrome"
```

`--executable`, `--playwright` and `--output` are required. The output directory
must not exist, and its parent must exist. All browser profiles are created
inside that new directory. The repository's runtime payload is snapshotted and
hashed before loading; `--extension "/path/to/extension"` selects another source
directory. Only the manifest, runtime scripts/styles/HTML, icons and locales are
snapshotted. `--package` additionally checks the rebuilt Chrome package.

The terminal HTTP proxy generates synthetic responses and never forwards
requests. Unmodeled traffic and HTTPS CONNECT requests are denied. Before
loading the extension, the preflight verifies both page and service-worker
traffic use the proxy, then verifies they fail closed with the proxy unavailable
and that the direct sentinel received no requests. Sessions, API keys, OAuth,
imports and chat use synthetic fixture values in fresh browser profiles.

Results are written to `feature-results.json`, with `isolation.json`,
`network.json`, screenshots, runtime snapshots and hashes alongside it. A blocked
run or failed feature produces a nonzero exit status. The report records actual
start/finish timestamps and does not claim a documentation retrieval date.

### Coverage and skips

- Real provider sign-in, external XHR capture, live quota and Firefox containers
  are deliberately skipped.
- Worker restart is covered; cold browser restart is skipped.
- Required API-key extras are skipped when `google-pse-search` is absent from
  the shipped catalog.
- Native toolbar popup negotiation is skipped if Playwright cannot expose its
  target. Full-tab and `window=1` rendering do not verify native window chrome.
- Packaged smoke is skipped when `--package` is omitted.

Consult each report's per-feature status and reason for the skips in that run.
