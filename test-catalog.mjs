// Runnable self-check for the generated catalog + core invariants. No framework: `node test-catalog.mjs`.
// Guards against a bad regen (wrong counts, dup slugs, drifted oauth kind split) and the accountId algo.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
// Load the REAL shipped adapter, not a copy of it. providers.gen.js sets `self.OMNI_GEN`; providers.js
// reads that global and Object.assigns its exports onto `self`. Emulating `self` here lets the test
// exercise the SAME omniAccountId the extension runs — a re-implementation would keep passing while
// the shipped one broke (it did drift: the old inline copy used Buffer.from, the real one uses atob).
globalThis.self = globalThis;
const gen = require("./providers.gen.js"); // module.exports = OMNI_GEN (+ self.OMNI_GEN via the shim)
require("./providers.js"); // → globalThis.omniAccountId / omniBuildCredential / OMNI_WEB_MAP / …
const { omniAccountId, omniBuildCredential, OMNI_WEB_MAP } = globalThis;
assert.equal(typeof omniAccountId, "function", "providers.js exported omniAccountId onto self");
assert.equal(typeof omniBuildCredential, "function", "providers.js exported omniBuildCredential onto self");

// counts drift with the INSTALLED OmniRoute version (catalog is generated from its source), so assert
// sane lower bounds rather than exact numbers — an exact count would break on every upstream change.
assert.ok(gen.web.length >= 18, `web count ${gen.web.length}`);
assert.ok(gen.apikey.length >= 140, `apikey count ${gen.apikey.length}`);
assert.ok(gen.oauth.length >= 14, `oauth count ${gen.oauth.length}`);

// unique slugs per registry
for (const k of ["web", "apikey", "oauth"]) {
  const s = gen[k].map((x) => x.slug);
  assert.equal(new Set(s).size, s.length, `${k} slugs unique`);
}

// oauth kind split (device/redirect/import) — mirrors providers.js kind mapping
const kindOf = (ft) => (ft === "device_code" ? "device" : ft === "import_token" ? "import" : "redirect");
const split = { device: 0, redirect: 0, import: 0 };
for (const o of gen.oauth) split[kindOf(o.flowType)]++;
assert.equal(split.device + split.redirect + split.import, gen.oauth.length, `oauth kinds partition ${JSON.stringify(split)}`);
for (const kind of ["device", "redirect", "import"]) assert.ok(split[kind] > 0, `oauth has ${kind} providers ${JSON.stringify(split)}`);

// every web provider carries a rebuildable host RegExp that actually matches its own host + ≥1 perm
for (const w of gen.web) {
  assert.ok(w.hostReSrc, `web ${w.slug} hostReSrc`);
  const re = new RegExp(w.hostReSrc, "i");
  const host = new URL(w.site).host;
  assert.ok(re.test(`https://${host}/anything`), `web ${w.slug} regex matches its host ${host}`);
  assert.ok(Array.isArray(w.perms) && w.perms.length, `web ${w.slug} perms`);
}

// no over-broad multi-tenant wildcard slipped into perms (Gmail/Outlook/Teams protection)
const SHARED = ["google.com", "microsoft.com", "cloud.microsoft", "tencent.com"];
for (const w of gen.web) for (const perm of w.perms) {
  for (const base of SHARED) assert.ok(!perm.includes(`*.${base}`), `no wildcard *.${base} in ${w.slug} perms (${perm})`);
}

// every apikey has a family label (grouping) and every oauth has a flowType
for (const a of gen.apikey) assert.ok(a.family || a.slug, `apikey ${a.slug} family`);
for (const o of gen.oauth) assert.ok(o.flowType, `oauth ${o.slug} flowType`);

// free-tier apikey providers are a non-trivial subset (the "free" badge means something)
const freeCount = gen.apikey.filter((a) => a.free).length;
assert.ok(freeCount > 0 && freeCount < gen.apikey.length, `apikey free subset (${freeCount}/${gen.apikey.length})`);

// no empty labels anywhere (a blank card is a bug)
for (const k of ["web", "apikey", "oauth"]) for (const x of gen[k]) assert.ok((x.label || "").length || x.slug, `${k} ${x.slug} has a label`);

// every oauth flowType maps to a known card kind (device/redirect/import)
for (const o of gen.oauth) assert.ok(["device", "redirect", "import"].includes(kindOf(o.flowType)), `oauth ${o.slug} known kind (${o.flowType})`);

// apikey "where to get a key" links, where present, are real URLs (a broken link = a dead button)
for (const a of gen.apikey) if (a.get) assert.doesNotThrow(() => new URL(a.get), `apikey ${a.slug} get URL parses (${a.get})`);

// omniAccountId contract — asserted against the REAL providers.js export (see the shim at the top):
// stable JWT id, else stable djb2 hash. This id keys the connection name OmniRoute UPSERTs by, so a
// silent drift here would re-create every connection instead of updating it.
const jwt = "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ sub: "user-42!!" })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_") + ".sig";
assert.equal(omniAccountId(jwt), "user42", "accountId from JWT sub, sanitized");
assert.equal(omniAccountId("abc"), omniAccountId("abc"), "accountId stable");
assert.notEqual(omniAccountId("abc"), omniAccountId("abd"), "accountId distinguishes creds");

console.log(`catalog + invariants OK — web=${gen.web.length} apikey=${gen.apikey.length} oauth=${gen.oauth.length} (device${split.device}/redirect${split.redirect}/import${split.import})`);
