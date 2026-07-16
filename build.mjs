// Emits clean per-browser builds from the shared source at repo root.
//   build/chrome/   — MV3 service_worker only (no Firefox-only keys → no warnings)
//   build/firefox/  — MV3 background.scripts + gecko id (Firefox 128+)
// The repo ROOT manifest is Chrome-only (service_worker) — Chrome MV3 HARD-rejects background.scripts,
// so a single cross-browser manifest is impossible. Load root or build/chrome/ in Chrome; load
// build/firefox/ in Firefox. Run: node build.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = ['providers.gen.js', 'providers.js', 'background.js', 'popup.html', 'popup.css', 'popup.js', 'content-aistudio.js'];
const DIRS = ['icons', '_locales']; // copied wholesale — _locales carries a messages.json per locale
const root = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

// manifest.json is the version the browser sees — package.json must not drift from it (they silently
// did: 4.22.5 vs 4.21.0). Fail the build rather than ship two answers to "which version is this?".
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (pkg.version !== root.version) {
  throw new Error(`version drift: manifest.json=${root.version} vs package.json=${pkg.version} — bump both`);
}

function emit(dir, manifest) {
  const out = join(ROOT, 'build', dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of SRC) copyFileSync(join(ROOT, f), join(out, f));
  for (const d of DIRS) cpSync(join(ROOT, d), join(out, d), { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('built build/' + dir);
}

// Chrome: service_worker only, drop the Firefox-only keys.
const chrome = { ...root, background: { service_worker: 'background.js' } };
delete chrome.browser_specific_settings;
emit('chrome', chrome);

// Firefox: background.scripts (providers first so background.js sees its globals without importScripts) + gecko id.
const firefox = {
  ...root,
  background: { scripts: ['providers.gen.js', 'providers.js', 'background.js'] },
  browser_specific_settings: { gecko: { id: 'omniroute-bridge@castellyn', strict_min_version: '128.0' } },
};
emit('firefox', firefox);
