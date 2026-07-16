// i18n contract gate. `chrome.i18n.getMessage("missing_key")` returns "" — a silently blank button is
// the classic localisation failure, and neither `node --check` nor the render smoke would notice.
// This asserts: every key the code uses exists in EVERY locale, all locales carry the same key set,
// and no message file rots into dead entries. Run: `npm run test:i18n`.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const EXT = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(EXT, "_locales");
assert.ok(existsSync(LOCALES_DIR), "_locales/ exists");

// ── what the code asks for ──────────────────────────────────────────────────
const SOURCES = ["popup.js", "background.js", "popup.html", "content-aistudio.js", "providers.js"];
const used = new Map(); // key -> [where]
const add = (k, where) => used.set(k, [...(used.get(k) || []), where]);

for (const f of SOURCES) {
  const p = join(EXT, f);
  if (!existsSync(p)) continue;
  const s = readFileSync(p, "utf8");
  // t("key") in the UI files, T("key", fallback) in providers.js, and chrome.i18n.getMessage("key")
  for (const m of s.matchAll(/\b[tT]\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) add(m[1], f);
  for (const m of s.matchAll(/getMessage\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) add(m[1], f);
  // data-i18n="key" / data-i18n-title="key" / data-i18n-placeholder="key"
  for (const m of s.matchAll(/data-i18n(?:-[a-z]+)?=["']([A-Za-z0-9_]+)["']/g)) add(m[1], f);
}
assert.ok(used.size > 0, "the scan found no i18n keys at all — is the wiring in place?");

// ── what the locales provide ────────────────────────────────────────────────
const locales = readdirSync(LOCALES_DIR).filter((d) => existsSync(join(LOCALES_DIR, d, "messages.json")));
assert.ok(locales.includes("ru"), "_locales/ru exists");
assert.ok(locales.includes("en"), "_locales/en exists");

const msgs = {};
for (const loc of locales) {
  const raw = readFileSync(join(LOCALES_DIR, loc, "messages.json"), "utf8");
  let json;
  assert.doesNotThrow(() => { json = JSON.parse(raw); }, `_locales/${loc}/messages.json parses`);
  msgs[loc] = json;
  for (const [k, v] of Object.entries(json)) {
    assert.ok(v && typeof v.message === "string" && v.message.length, `${loc}: "${k}" has a non-empty message`);
  }
}

// ── the contract ────────────────────────────────────────────────────────────
for (const loc of locales) {
  const have = new Set(Object.keys(msgs[loc]));
  const missing = [...used.keys()].filter((k) => !have.has(k));
  assert.deepEqual(missing, [], `_locales/${loc} is missing keys used in code: ${missing.slice(0, 8).join(", ")}`);
}

const ruKeys = Object.keys(msgs.ru).sort();
for (const loc of locales.filter((l) => l !== "ru")) {
  const locKeys = Object.keys(msgs[loc]).sort();
  const onlyRu = ruKeys.filter((k) => !locKeys.includes(k));
  const onlyLoc = locKeys.filter((k) => !ruKeys.includes(k));
  assert.deepEqual(onlyRu, [], `${loc} is missing: ${onlyRu.slice(0, 8).join(", ")}`);
  assert.deepEqual(onlyLoc, [], `${loc} has keys ru lacks: ${onlyLoc.slice(0, 8).join(", ")}`);
}

// Placeholders must line up: "$1" in ru means "$1" must exist in every other locale, or a translated
// string silently drops the number/name it was supposed to interpolate.
for (const k of ruKeys) {
  const refs = (s) => [...new Set([...s.matchAll(/\$(\d)/g)].map((m) => m[1]))].sort();
  const want = refs(msgs.ru[k].message);
  for (const loc of locales.filter((l) => l !== "ru")) {
    assert.deepEqual(refs(msgs[loc][k].message), want, `${loc}."${k}" must interpolate the same $n as ru`);
  }
}

// Dead entries are rot: they outlive the string they were written for and mislead the next translator.
const dead = ruKeys.filter((k) => !used.has(k) && !k.startsWith("ext_"));
assert.deepEqual(dead, [], `unused message keys (delete or use them): ${dead.slice(0, 8).join(", ")}`);

console.log(`i18n OK — ${used.size} keys used, locales: ${locales.join(", ")} (${ruKeys.length} messages each)`);
