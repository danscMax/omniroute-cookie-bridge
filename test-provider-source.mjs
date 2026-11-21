import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { ProviderSource } from "./provider-source.mjs";

function fixture(files, run) {
  const root = mkdtempSync(join(process.env.BRIDGE_TEST_TMPDIR || tmpdir(), "bridge-source-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    return run(new ProviderSource(root), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("registry reads stay within object boundaries and preserve literal metadata", () => {
  fixture({ "index.ts": `
    export const PROVIDERS = {
      paid: { website: 'https://paid.example', name: 'Paid', id: 'paid', hasFree: false,
        authHint: 'A long hint ' + '${"x".repeat(1100)}', notice: { apiKeyUrl: 'https://paid.example/keys' } },
      free: { id: 'free', name: 'Free', hasFree: true, website: 'https://free.example' }
    } as const;
    throw new Error('Source modules must never execute');
  ` }, (s) => {
    const rows = s.properties(s.exported("index.ts", "PROVIDERS"));
    assert.deepEqual(s.fields(rows.get("paid"), ["id", "name", "website", "hasFree", "notice"]), {
      id: "paid", name: "Paid", website: "https://paid.example", hasFree: false,
      notice: { apiKeyUrl: "https://paid.example/keys" },
    });
    assert.equal(s.fields(rows.get("free"), ["hasFree"]).hasFree, true);
  });
});

test("imports, re-exports, spreads, aliases and shared OAuth factories are resolved statically", () => {
  fixture({
    "index.ts": `import { rows } from './barrel'; import { device, browser } from './flows';
      export const PROVIDERS = { ...rows, alias: device, browser };
      export const SECTIONS = [PROVIDERS] as const;`,
    "barrel.ts": `export { rows } from './rows';`,
    "rows.ts": "export const rows = { one: { id: 'one', name: `Provider ${'one'}` } };",
    "flows.ts": `const common = { flowType: 'device_code' }; export const device = { ...common, config: {} };
      function makeBrowser() { return { flowType: 'authorization_code_pkce', exchange() {} }; }
      export const browser = makeBrowser();`,
  }, (s) => {
    const rows = s.properties(s.exported("index.ts", "PROVIDERS"));
    assert.deepEqual([...rows.keys()], ["one", "alias", "browser"]);
    assert.equal(s.fields(rows.get("one"), ["name"]).name, "Provider one");
    assert.equal(s.flow(rows.get("alias")), "device_code");
    assert.equal(s.flow(rows.get("browser")), "authorization_code_pkce");
    assert.equal(s.items(s.exported("index.ts", "SECTIONS")).length, 1);
  });
});

test("duplicate ids, cyclic exports and computed metadata fail rather than silently truncating", () => {
  fixture({
    "duplicate.ts": "export const rows = { one: {}, one: {} };",
    "cycle-a.ts": "export { rows } from './cycle-b';",
    "cycle-b.ts": "export { rows } from './cycle-a';",
    "computed.ts": "export const rows = { one: { id: 'one', name: process.env.NAME } };",
  }, (s) => {
    assert.throws(() => s.properties(s.exported("duplicate.ts", "rows")), /Duplicate registry key/);
    assert.throws(() => s.exported("cycle-a.ts", "rows"), /Cyclic registry export/);
    assert.throws(() => s.fields(s.properties(s.exported("computed.ts", "rows")).get("one"), ["name"]), /Unsupported computed metadata/);
  });
});

test("array spreads detect cycles without flattening nested arrays or rejecting reuse", () => {
  fixture({ "index.ts": `export const cyclic = [...cyclic];
    const left = [...right]; const right = [...left]; export const indirect = left;
    const leaf = ['one']; export const repeated = [...leaf, ...leaf];
    export const nested = [...[leaf, ...[leaf]], [leaf]];
    export const invalid = [...{}];` }, (s) => {
    assert.throws(() => s.items(s.exported("index.ts", "cyclic")), /Cyclic registry array spread/);
    assert.throws(() => s.items(s.exported("index.ts", "indirect")), /Cyclic registry array spread/);
    assert.throws(() => s.value(s.exported("index.ts", "cyclic")), /Cyclic registry value/);
    assert.throws(() => s.value(s.exported("index.ts", "indirect")), /Cyclic registry value/);
    assert.deepEqual(s.items(s.exported("index.ts", "repeated")).map((r) => s.value(r)), ["one", "one"]);
    const nested = [["one"], ["one"], [["one"]]];
    assert.deepEqual(s.items(s.exported("index.ts", "nested")).map((r) => s.value(r)), nested);
    assert.deepEqual(s.value(s.exported("index.ts", "nested")), nested);
    assert.throws(() => s.value(s.exported("index.ts", "invalid")), /Expected a literal registry array/);
  });
});

test("OAuth shorthand and computed overrides follow object property precedence", () => {
  fixture({ "index.ts": `const base = { flowType: 'device_code' };
    const flowType = 'authorization_code';
    export const shorthand = { ...base, flowType };
    export const computed = { ...base, ['flowType']: 'authorization_code_pkce' };
    export const spreadLast = { flowType, ...base };
    const key = 'flow' + 'Type';
    export const nested = { ...base, ...{ [key]: flowType } };
    export const absent = { ...base, ...{} };
    export const cleared = { ...base, ...{ flowType: undefined } };
    export const nullified = { ...base, ...{ flowType: null } };
    export const empty = { ...base, ...{ flowType: '' } };
    export const disabled = { ...base, ...{ flowType: false } };
    export const getter = { ...base, get flowType() { throw new Error('Never execute getters'); } };` }, (s) => {
    assert.equal(s.flow(s.exported("index.ts", "shorthand")), "authorization_code");
    assert.equal(s.flow(s.exported("index.ts", "computed")), "authorization_code_pkce");
    assert.equal(s.flow(s.exported("index.ts", "spreadLast")), "device_code");
    assert.equal(s.flow(s.exported("index.ts", "nested")), "authorization_code");
    assert.equal(s.flow(s.exported("index.ts", "absent")), "device_code");
    assert.equal(s.flow(s.exported("index.ts", "cleared")), undefined);
    assert.equal(s.flow(s.exported("index.ts", "nullified")), null);
    assert.equal(s.flow(s.exported("index.ts", "empty")), "");
    assert.equal(s.flow(s.exported("index.ts", "disabled")), false);
    assert.throws(() => s.flow(s.exported("index.ts", "getter")), /OAuth flowType must be a static property/);
  });
});

test("OAuth factory arguments shadow module bindings and retain caller scope", () => {
  fixture({ "index.ts": `const kind = 'device_code';
    function make(kind, fallback = kind) { return { flowType: fallback }; }
    export const literal = make('authorization_code_pkce');
    export const sameName = make(kind);
    export const missing = make();
    function destructured({ flowType }) { return { flowType }; }
    export const unsupported = destructured({ flowType: 'device_code' });
    const args = ['authorization_code']; export const spread = make(...args);
    function dynamic() { throw new Error('Never execute factories'); return { flowType: 'device_code' }; }
    export const sideEffect = dynamic();
    throw new Error('Never execute source modules');` }, (s) => {
    assert.equal(s.flow(s.exported("index.ts", "literal")), "authorization_code_pkce");
    assert.equal(s.flow(s.exported("index.ts", "sameName")), "device_code");
    assert.throws(() => s.flow(s.exported("index.ts", "missing")), /Unresolved OAuth factory parameter/);
    assert.throws(() => s.flow(s.exported("index.ts", "unsupported")), /Unsupported OAuth factory parameter binding/);
    assert.throws(() => s.flow(s.exported("index.ts", "spread")), /Unsupported OAuth factory spread argument/);
    assert.throws(() => s.flow(s.exported("index.ts", "sideEffect")), /OAuth factory must return a statically readable object/);
  });
});

test("OAuth factories preserve lexical module closures and imported caller arguments", () => {
  fixture({
    "factory.ts": `const kind = 'device_code'; const alias = kind;
      const shared = { flowType: kind };
      export function make(kind, fallback = alias) { return { flowType: fallback }; }
      export function direct(kind) { return { flowType: kind }; }
      export function fromShared(kind) { return { ...shared }; }
      function helper() { return { flowType: kind }; }
      export function wrapper(kind) { return helper(); }
      throw new Error('Never execute imported factories');`,
    "index.ts": `import { make, direct, fromShared, wrapper } from './factory';
      const kind = 'authorization_code'; const alias = kind;
      export const closure = make('authorization_code_pkce');
      export const caller = direct(kind); export const callerAlias = direct(alias);
      export const objectClosure = fromShared('authorization_code_pkce');
      export const unusedMissing = fromShared();
      export const helperClosure = wrapper('authorization_code_pkce');
      export const missing = direct();`,
  }, (s) => {
    for (const name of ["closure", "objectClosure", "unusedMissing", "helperClosure"]) {
      assert.equal(s.flow(s.exported("index.ts", name)), "device_code", name);
    }
    for (const name of ["caller", "callerAlias"]) assert.equal(s.flow(s.exported("index.ts", name)), "authorization_code", name);
    assert.throws(() => s.flow(s.exported("index.ts", "missing")), /Unresolved OAuth factory parameter kind/);
  });
});

test("OAuth defaults honor undefined, earlier parameters and parameter initialization scope", () => {
  fixture({ "index.ts": `const kind = 'outer'; const later = 'outer'; const omitted = undefined;
    function make(kind = 'device_code', fallback = kind) { return { flowType: fallback }; }
    export const implicit = make(); export const explicit = make(undefined);
    export const alias = make(omitted); export const nullValue = make(null);
    export const earlier = make('authorization_code', undefined);
    function forward(kind) { return make(kind); } export const forwardedMissing = forward();
    function shadow(undefined) { return make(undefined); }
    export const shadowed = shadow('authorization_code_pkce');
    function shadowDefault(undefined = 'authorization_code') { return { flowType: undefined }; }
    export const shadowedDefault = shadowDefault();
    function unavailable(kind = later, later = 'device_code') { return { flowType: kind }; }
    export const laterDefault = unavailable();
    export const laterArgument = unavailable(undefined, 'authorization_code');
    function self(kind = kind) { return { flowType: kind }; } export const selfDefault = self();
    function computed(kind = process.env.FLOW) { return { flowType: kind }; } export const dynamic = computed();
    throw new Error('Never execute defaults');` }, (s) => {
    for (const name of ["implicit", "explicit", "alias", "forwardedMissing"]) assert.equal(s.flow(s.exported("index.ts", name)), "device_code", name);
    assert.equal(s.flow(s.exported("index.ts", "nullValue")), null);
    assert.equal(s.flow(s.exported("index.ts", "earlier")), "authorization_code");
    assert.equal(s.flow(s.exported("index.ts", "shadowed")), "authorization_code_pkce");
    assert.equal(s.flow(s.exported("index.ts", "shadowedDefault")), "authorization_code");
    for (const name of ["laterDefault", "laterArgument"]) {
      assert.throws(() => s.flow(s.exported("index.ts", name)), /Uninitialized OAuth factory parameter later/, name);
    }
    assert.throws(() => s.flow(s.exported("index.ts", "selfDefault")), /Uninitialized OAuth factory parameter kind/);
    assert.throws(() => s.flow(s.exported("index.ts", "dynamic")), /Unsupported computed metadata/);
  });
});

test("nested OAuth factory invocations are distinct scopes while recursive definitions fail", () => {
  fixture({ "index.ts": `const base = { flowType: 'device_code' };
    function wrap(provider) { return { ...provider }; } export const nested = wrap(wrap(base));
    function forward(provider) { return wrap(provider); } export const forwarded = forward(forward(base));
    function withDefault(provider = withDefault(base)) { return { ...provider }; } export const defaultNested = withDefault();
    function recurse() { return recurse(); } export const recursive = recurse();
    function left() { return right(); } function right() { return left(); } export const indirect = left();
    function defaultCycle(provider = defaultCycle()) { return provider; } export const defaultRecursive = defaultCycle();
    export const argumentCycle = wrap(argumentCycle);` }, (s) => {
    for (const name of ["nested", "forwarded", "defaultNested"]) assert.equal(s.flow(s.exported("index.ts", name)), "device_code", name);
    for (const name of ["recursive", "indirect", "defaultRecursive", "argumentCycle"]) {
      assert.throws(() => s.flow(s.exported("index.ts", name)), /Cyclic OAuth provider/, name);
    }
    assert.equal(s.flow(s.exported("index.ts", "nested")), "device_code");
  });
});

test("value and object cycles fail explicitly without poisoning independent references", () => {
  fixture({ "index.ts": `const left = right; const right = left; export const aliases = left;
    export const self = { self }; const a = { next: b }; const b = { next: a }; export const indirect = a;
    export const mixed = { items: [mixed] };
    export const spread = { ...spread }; const x = { ...y }; const y = { ...x }; export const indirectSpread = x;
    const leaf = { kind: 'device_code' }; const array = ['one'];
    export const independent = { a: leaf, b: leaf, arrays: [array, array] };` }, (s) => {
    assert.throws(() => s.properties(s.exported("index.ts", "aliases")), /Cyclic registry reference/);
    for (const name of ["aliases", "self", "indirect", "mixed"]) {
      assert.throws(() => s.value(s.exported("index.ts", name)), /Cyclic registry value/, name);
    }
    for (const name of ["spread", "indirectSpread"]) {
      assert.throws(() => s.properties(s.exported("index.ts", name)), /Cyclic registry spread/, name);
    }
    assert.deepEqual(s.value(s.exported("index.ts", "independent")), {
      a: { kind: "device_code" }, b: { kind: "device_code" }, arrays: [["one"], ["one"]],
    });
  });
});

test("git refs read immutable registry blobs without changing a dirty checkout", () => {
  fixture({
    "index.ts": "export const provider = { name: 'working tree' }; throw new Error('Never execute checkout');",
    "untracked.ts": "untracked fixture bytes\r\n",
  }, (working, root) => {
    const git = (args, input) => execFileSync("git", ["--no-optional-locks", ...args], {
      cwd: root, encoding: "utf8", timeout: 10000, input, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    git(["init", "--quiet"]);
    const blob = (text) => git(["hash-object", "-w", "--stdin"], text);
    const version = (name) => {
      const index = blob("export { provider } from './shared'; throw new Error('Never execute pinned modules');");
      const shared = blob(`export const provider = { name: '${name}' }; throw new Error('Never execute pinned imports');`);
      const tree = git(["mktree"], `100644 blob ${index}\tindex.ts\n100644 blob ${shared}\tshared.ts\n`);
      // Populate only the disposable fixture's object database; no git commit or checkout command.
      return git(["hash-object", "-t", "commit", "-w", "--stdin"],
        `tree ${tree}\nauthor Fixture <fixture@example.test> 1700000000 +0000\ncommitter Fixture <fixture@example.test> 1700000000 +0000\n\nRegistry fixture\n`);
    };
    const first = version("pinned");
    git(["update-ref", "refs/heads/fixture", first]);
    git(["symbolic-ref", "HEAD", "refs/heads/fixture"]);
    const pinned = new ProviderSource(root, { ref: "HEAD" });
    const latest = version("latest");
    git(["update-ref", "refs/heads/fixture", latest]);
    git(["read-tree", latest]);
    const state = () => ({
      head: git(["rev-parse", "HEAD"]), status: git(["status", "--porcelain=v1", "--untracked-files=all"]),
      index: readFileSync(join(root, ".git", "index")),
      tracked: readFileSync(join(root, "index.ts")), untracked: readFileSync(join(root, "untracked.ts")),
    });
    const before = state();
    assert.equal(pinned.ref, first);
    assert.deepEqual(pinned.fields(pinned.exported("index.ts", "provider"), ["name"]), { name: "pinned" });
    const current = new ProviderSource(root, { ref: "HEAD" });
    assert.deepEqual(current.fields(current.exported("index.ts", "provider"), ["name"]), { name: "latest" });
    assert.deepEqual(working.fields(working.exported("index.ts", "provider"), ["name"]), { name: "working tree" });
    assert.deepEqual(state(), before);
  });
});
