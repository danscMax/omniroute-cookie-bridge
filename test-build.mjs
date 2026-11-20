// Offline packaging regressions: execute only the generator/build tools in disposable copies.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOOPBACK = 'http://127.0.0.1/*';
const PAYLOAD = ['providers.gen.js', 'providers.js', 'background.js', 'popup.html', 'popup.css', 'popup.js', 'content-aistudio.js'];
const INPUTS = ['manifest.json', 'package.json', 'gen-providers.mjs', 'build.mjs', ...PAYLOAD];
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
  const temp = mkdtempSync(join(process.env.BRIDGE_TEST_TMPDIR || tmpdir(), 'bridge-build-'));
  const repo = join(temp, 'extension');
  const omni = join(temp, 'registry');
  mkdirSync(repo);
  try {
    for (const file of INPUTS) copyFileSync(join(ROOT, file), join(repo, file));
    for (const dir of ASSETS) cpSync(join(ROOT, dir), join(repo, dir), { recursive: true });
    put(omni, 'open-sse/services/tokenExtractionConfig.ts', `
config("fixture-web", "Fixture Web", "https://chat.example.test/login", "https://chat.example.test", [{ type: "cookie", name: "session" }], "Fixture instructions");
config("fixture-shared", "Shared host", "https://aistudio.google.com/login", "https://aistudio.google.com", [], "Fixture instructions");
`);
    put(omni, 'src/shared/constants/providers/apikey/gateways.ts', 'export const APIKEY_PROVIDERS_GATEWAYS = { fixture: { id: "fixture-key", name: "Fixture Key", website: "https://keys.example.test", hasFree: true } };\n');
    put(omni, 'src/lib/oauth/providers/fixture-oauth.ts', 'export const provider = { id: "fixture-oauth", flowType: "device_code" };\n');
    // Do not run global npm discovery or inherit provider/proxy configuration.
    const env = { PATH: '', OMNI_ROOT: omni, SCRIPTS_ROOT: temp, APPDATA: temp, HOME: temp, USERPROFILE: temp, TEMP: temp, TMP: temp };
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const execute = (script) => {
      const result = spawnSync(process.execPath, [join(repo, script)], {
        cwd: repo, env, encoding: 'utf8', timeout: 15000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, `${script} terminated by signal`);
      return result;
    };
    run({ repo, omni, execute });
  } finally {
    rmSync(temp, { recursive: true, force: true });
    assert.deepEqual(snapshot(ROOT, sourcePaths), before, 'real source files must remain byte-identical');
  }
}

function succeeds(execute, script) {
  const result = execute(script);
  assert.equal(result.status, 0, `${script}\n${result.stdout}\n${result.stderr}`);
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
    assert.deepEqual(snapshot(out, payloadPaths), snapshot(repo, payloadPaths), `${browser}: payload bytes preserved`);
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

test('both browser packages preserve sources and exclude development files on rebuild', () => {
  withFixture(({ repo, execute }) => {
    for (const path of ['node_modules/fixture/index.js', 'tests/fixture.js', 'test-fixture.mjs', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'package-lock.json']) {
      put(repo, path, 'development-only fixture\n');
    }
    const sourcePaths = files(repo);
    const before = snapshot(repo, sourcePaths);
    succeeds(execute, 'build.mjs');
    for (const browser of ['chrome', 'firefox']) put(repo, `build/${browser}/stale.txt`, 'stale output');
    succeeds(execute, 'build.mjs');
    assert.deepEqual(snapshot(repo, sourcePaths), before, 'build must not modify source files');
    verifyBuild(repo, json(join(repo, 'manifest.json')));
  });
});

test('real generator uses fixture registries, is idempotent, and packages consistent permissions', () => {
  withFixture(({ repo, omni, execute }) => {
    const original = json(join(repo, 'manifest.json'));
    const preservedPaths = files(repo).filter((path) => !['manifest.json', 'providers.gen.js'].includes(path));
    const before = snapshot(repo, preservedPaths);
    const registryPaths = files(omni);
    const registryBefore = snapshot(omni, registryPaths);
    succeeds(execute, 'gen-providers.mjs');
    const generatedPaths = ['manifest.json', 'providers.gen.js'];
    const first = snapshot(repo, generatedPaths);
    succeeds(execute, 'gen-providers.mjs');
    assert.deepEqual(snapshot(repo, generatedPaths), first, 'generation must be byte-idempotent');
    assert.deepEqual(snapshot(repo, preservedPaths), before, 'generator must preserve other source files');
    assert.deepEqual(snapshot(omni, registryPaths), registryBefore, 'registry inputs must remain unchanged');
    const generated = json(join(repo, 'manifest.json'));
    assert.deepEqual({ ...generated, host_permissions: original.host_permissions }, original, 'only required host permissions may change');
    const context = { module: { exports: {} } };
    runInNewContext(readFileSync(join(repo, 'providers.gen.js'), 'utf8'), context, { timeout: 1000 });
    const catalog = JSON.parse(JSON.stringify(context.module.exports));
    assert.deepEqual(catalog.apikey.map((provider) => provider.slug), ['fixture-key']);
    assert.deepEqual(catalog.oauth, [{ slug: 'fixture-oauth', label: 'fixture-oauth', flowType: 'device_code' }]);
    assert.ok(catalog.web.some((provider) => provider.slug === 'fixture-web'));
    assert.ok(catalog.web.some((provider) => provider.slug === 'fixture-shared'));
    assert.deepEqual(catalog.web.find((provider) => provider.slug === 'fixture-web').perms,
      ['https://chat.example.test/*', 'https://*.example.test/*', 'https://example.test/*']);
    assert.deepEqual(catalog.web.find((provider) => provider.slug === 'fixture-shared').perms, ['https://aistudio.google.com/*']);
    assert.ok(!generated.host_permissions.includes('https://*.google.com/*'));
    const fixed = [LOOPBACK, 'https://aistudio.google.com/*'];
    const webHosts = [...new Set(catalog.web.flatMap((provider) => provider.perms))];
    assert.deepEqual(generated.host_permissions, [...fixed, ...webHosts.filter((host) => !fixed.includes(host)).sort()]);
    loopbackPermissions(generated, 'generated');
    const beforeBuild = snapshot(repo, files(repo));
    succeeds(execute, 'build.mjs');
    assert.deepEqual(snapshot(repo, Object.keys(beforeBuild)), beforeBuild, 'packaging must preserve generated sources');
    verifyBuild(repo, generated);
  });
});

test('version drift fails before creating either browser package', () => {
  withFixture(({ repo, execute }) => {
    const pkg = json(join(repo, 'package.json'));
    pkg.version = '0.0.0';
    put(repo, 'package.json', JSON.stringify(pkg));
    const result = execute('build.mjs');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /version drift/);
    assert.ok(!existsSync(join(repo, 'build')), 'failed validation must not emit packages');
  });
});

test('port-qualified loopback regression fails before creating either browser package', () => {
  withFixture(({ repo, execute }) => {
    const manifest = json(join(repo, 'manifest.json'));
    manifest.host_permissions = manifest.host_permissions.filter((host) => !host.startsWith('http:'));
    manifest.host_permissions.unshift('http://127.0.0.1:20128/*');
    put(repo, 'manifest.json', JSON.stringify(manifest));
    const result = execute('build.mjs');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /portless loopback permission/);
    assert.ok(!existsSync(join(repo, 'build')), 'failed validation must not emit packages');
  });
});
