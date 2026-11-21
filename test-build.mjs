// Offline packaging regressions in disposable copies. AST generation has its own test-generator suite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOOPBACK = 'http://127.0.0.1/*';
const PAYLOAD = ['providers.gen.js', 'providers.js', 'background.js', 'popup.html', 'popup.css', 'popup.js', 'content-aistudio.js'];
const DEVELOPMENT = ['gen-providers.mjs', 'provider-source.mjs', 'provider-capabilities.mjs', 'provider-coverage.json'];
const INPUTS = ['manifest.json', 'package.json', 'build.mjs', ...DEVELOPMENT, ...PAYLOAD];
const ASSETS = ['icons', '_locales'];
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

function put(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function files(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(root, path) : [path];
  }).sort();
}

function snapshot(root, paths) {
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(root, path))]));
}

function withFixture(run) {
  const sourcePaths = [...INPUTS, ...ASSETS.flatMap((dir) => files(ROOT, dir))];
  const before = snapshot(ROOT, sourcePaths);
  const parent = process.env.BRIDGE_TEST_TMPDIR || tmpdir();
  const temp = mkdtempSync(join(parent, 'bridge-build-'));
  const repo = join(temp, 'extension');
  mkdirSync(repo);
  try {
    for (const file of INPUTS) copyFileSync(join(ROOT, file), join(repo, file));
    for (const dir of ASSETS) cpSync(join(ROOT, dir), join(repo, dir), { recursive: true });
    // Only the absolute Node executable is invoked. No npm discovery, registry or proxy settings.
    const env = { PATH: '', APPDATA: temp, HOME: temp, USERPROFILE: temp, TEMP: temp, TMP: temp };
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec']) if (process.env[key]) env[key] = process.env[key];
    const execute = () => {
      const result = spawnSync(process.execPath, [join(repo, 'build.mjs')], {
        cwd: repo, env, encoding: 'utf8', timeout: 15000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, 'build terminated by signal');
      return result;
    };
    run({ repo, execute });
  } finally {
    rmSync(temp, { recursive: true, force: true });
    assert.deepEqual(snapshot(ROOT, sourcePaths), before, 'real source files must remain byte-identical');
  }
}

function succeeds(execute) {
  const result = execute();
  assert.equal(result.status, 0, `build.mjs\n${result.stdout}\n${result.stderr}`);
}

function loopbackPermissions(manifest, label) {
  assert.deepEqual(manifest.host_permissions.filter((host) => host.startsWith('http:')), [LOOPBACK], `${label}: required literal loopback permission must be portless`);
  assert.deepEqual(manifest.optional_host_permissions, [LOOPBACK], `${label}: optional loopback permission`);
}

function verifyBuild(repo, source) {
  const payloadPaths = [...PAYLOAD, ...ASSETS.flatMap((dir) => files(repo, dir))];
  for (const browser of ['chrome', 'firefox']) {
    const out = join(repo, 'build', browser);
    assert.deepEqual(files(out), [...payloadPaths, 'manifest.json'].sort(), `${browser}: only runtime files packaged`);
    assert.deepEqual(snapshot(out, payloadPaths), snapshot(repo, payloadPaths), `${browser}: full generated catalog and runtime payload preserved byte-for-byte`);
    const built = json(join(out, 'manifest.json'));
    const expected = { ...source };
    if (browser === 'chrome') {
      expected.background = { service_worker: 'background.js' };
      delete expected.browser_specific_settings;
    } else {
      expected.background = { scripts: ['providers.gen.js', 'providers.js', 'background.js'] };
      expected.browser_specific_settings = { gecko: { id: 'omniroute-bridge@castellyn', strict_min_version: '128.0' } };
    }
    assert.deepEqual(built, expected, `${browser}: background variant and shared manifest fields`);
    assert.equal(built.version, json(join(repo, 'package.json')).version, `${browser}: package version agreement`);
    loopbackPermissions(built, browser);
  }
}

test('shared manifest has a portless literal loopback permission and matching package version', () => {
  const manifest = json(join(ROOT, 'manifest.json'));
  assert.equal(manifest.version, json(join(ROOT, 'package.json')).version);
  loopbackPermissions(manifest, 'source');
});

test('both browser builds isolate runtime files, preserve the catalog and rebuild byte-idempotently', () => {
  withFixture(({ repo, execute }) => {
    for (const path of ['node_modules/fixture/index.js', 'tests/fixture.js', 'test-fixture.mjs', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'TESTING.md', 'package-lock.json', '.git/fixture']) {
      put(repo, path, 'development-only fixture\n');
    }
    const sourcePaths = files(repo);
    const before = snapshot(repo, sourcePaths);
    succeeds(execute);
    const outputPaths = files(join(repo, 'build'));
    const first = snapshot(join(repo, 'build'), outputPaths);
    for (const browser of ['chrome', 'firefox']) put(repo, `build/${browser}/stale.txt`, 'stale output');
    succeeds(execute);
    assert.deepEqual(files(join(repo, 'build')), outputPaths, 'rebuild removes stale output files');
    assert.deepEqual(snapshot(join(repo, 'build'), outputPaths), first, 'rebuild is byte-idempotent');
    assert.deepEqual(snapshot(repo, sourcePaths), before, 'build must not modify source or generator inputs');
    verifyBuild(repo, json(join(repo, 'manifest.json')));
  });
});

test('version drift fails before creating either browser package', () => {
  withFixture(({ repo, execute }) => {
    const pkg = json(join(repo, 'package.json'));
    pkg.version = '0.0.0';
    put(repo, 'package.json', JSON.stringify(pkg));
    const result = execute();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /version drift/);
    assert.ok(!existsSync(join(repo, 'build')), 'failed validation must not emit packages');
  });
});

for (const mode of ['missing', 'port-qualified', 'mixed']) test(`invalid ${mode} loopback permissions preserve existing packages`, () => {
  withFixture(({ repo, execute }) => {
    succeeds(execute);
    const outputPaths = files(join(repo, 'build'));
    const before = snapshot(join(repo, 'build'), outputPaths);
    const manifest = json(join(repo, 'manifest.json'));
    manifest.host_permissions = manifest.host_permissions.filter((host) => !host.startsWith('http:'));
    if (mode === 'mixed') manifest.host_permissions.unshift(LOOPBACK);
    if (mode !== 'missing') manifest.host_permissions.unshift('http://127.0.0.1:20128/*');
    put(repo, 'manifest.json', JSON.stringify(manifest));
    const result = execute();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /portless loopback permission/);
    assert.deepEqual(files(join(repo, 'build')), outputPaths);
    assert.deepEqual(snapshot(join(repo, 'build'), outputPaths), before, 'validation must precede removal of either existing package');
  });
});
