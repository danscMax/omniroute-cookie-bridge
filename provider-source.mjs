// Read literal registry data without importing or executing the provider/server modules.
import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

export class ProviderSource {
  constructor(root, { ref } = {}) {
    this.root = realpathSync(root);
    this.ref = ref ? execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: this.root, encoding: "utf8", timeout: 10000 }).trim() : null;
    this.files = new Map();
    this.texts = new Map();
    this.resolving = new Set();
    this.imports = new Set();
    this.scopeSerial = 0;
  }

  text(path) {
    const filename = this.ref ? resolve(this.root, path) : realpathSync(resolve(this.root, path));
    const rel = relative(this.root, filename).replaceAll("\\", "/");
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Registry import escapes source root");
    if (this.texts.has(filename)) return this.texts.get(filename);
    const text = this.ref
      ? execFileSync("git", ["show", `${this.ref}:${rel}`], { cwd: this.root, encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
      : readFileSync(filename, "utf8");
    this.texts.set(filename, text);
    return text;
  }

  exists(path) {
    if (!this.ref) return existsSync(resolve(this.root, path)) && statSync(resolve(this.root, path)).isFile();
    try { this.text(path); return true; } catch { return false; }
  }

  file(path) {
    const filename = this.ref ? resolve(this.root, path) : realpathSync(resolve(this.root, path));
    const rel = relative(this.root, filename);
    if (rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Registry import escapes source root");
    if (this.files.has(filename)) return this.files.get(filename);
    const text = this.text(filename);
    const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length) this.fail(ast, "Invalid TypeScript registry");
    const file = { filename, text, ast, scopeId: ++this.scopeSerial, bindings: new Map(), exports: new Map() };
    this.files.set(filename, file);
    for (const node of ast.statements) {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          file.bindings.set(decl.name.text, decl.initializer);
          if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) file.exports.set(decl.name.text, { local: decl.name.text });
        }
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        file.bindings.set(node.name.text, node);
        if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) file.exports.set(node.name.text, { local: node.name.text });
      } else if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
        const from = node.moduleSpecifier.text;
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const spec of bindings.elements) {
          if (!spec.isTypeOnly) file.bindings.set(spec.name.text, { from, imported: (spec.propertyName || spec.name).text });
        }
        if (node.importClause.name) file.bindings.set(node.importClause.name.text, { from, imported: "default" });
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const spec of node.exportClause.elements) {
          if (!spec.isTypeOnly) file.exports.set(spec.name.text, node.moduleSpecifier
            ? { from: node.moduleSpecifier.text, imported: (spec.propertyName || spec.name).text }
            : { local: (spec.propertyName || spec.name).text });
        }
      } else if (ts.isExportAssignment(node) && !node.isExportEquals) file.exports.set("default", { node: node.expression });
    }
    return file;
  }

  fail(node, message) {
    const file = node.getSourceFile();
    const { line } = file.getLineAndCharacterOfPosition(node.getStart());
    throw new Error(`${relative(this.root, file.fileName).replaceAll("\\", "/")}:${line + 1}: ${message}`);
  }

  importFile(file, from) {
    const base = from.startsWith("./") || from.startsWith("../") ? resolve(dirname(file.filename), from)
      : from.startsWith("@/") ? join(this.root, "src", from.slice(2))
      : from.startsWith("@omniroute/open-sse/") ? join(this.root, "open-sse", from.slice("@omniroute/open-sse/".length)) : null;
    if (!base) throw new Error(`Cannot statically read external import ${from}`);
    const candidate = [base, base + ".ts", join(base, "index.ts")].find((p) => /\.[cm]?[jt]sx?$/.test(p) && this.exists(p));
    if (!candidate) throw new Error(`Missing registry import ${from}`);
    return this.file(candidate);
  }

  exported(path, name) {
    const file = typeof path === "string" ? this.file(path) : path;
    const binding = file.exports.get(name);
    if (!binding) throw new Error(`Missing registry export ${name} in ${relative(this.root, file.filename)}`);
    const key = file.filename + ":export:" + name;
    if (this.imports.has(key)) throw new Error(`Cyclic registry export ${name}`);
    this.imports.add(key);
    try {
      if (binding.from) return this.exported(this.importFile(file, binding.from), binding.imported);
      return binding.node ? { file, node: binding.node } : this.binding(file, binding.local);
    } finally { this.imports.delete(key); }
  }

  bindingScope(file, name) {
    while (file && !file.bindings.has(name)) file = file.parent;
    return file;
  }

  binding(file, name) {
    const scope = this.bindingScope(file, name);
    if (!scope) throw new Error(`Cannot resolve registry constant ${name} in ${relative(this.root, file.filename)}`);
    const binding = scope.bindings.get(name);
    if (binding.unsupported) throw new Error(binding.unsupported);
    if (binding.reference) return binding.reference;
    return binding.from ? this.exported(this.importFile(scope, binding.from), binding.imported) : { file: scope, node: binding };
  }

  isUndefined(ref, seen = new Set()) {
    const { file, node: raw } = ref;
    const node = this.unwrap(raw);
    if (!ts.isIdentifier(node)) return false;
    const scope = this.bindingScope(file, node.text);
    if (!scope && node.text === "undefined") return true;
    const key = (scope || file).scopeId + ":" + node.text;
    if (seen.has(key)) this.fail(node, "Cyclic registry value");
    if (scope?.bindings.get(node.text).missing) return true;
    return this.isUndefined(this.binding(file, node.text), new Set([...seen, key]));
  }

  unwrap(node) {
    while (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  }

  dereference(ref) {
    let { file, node } = ref;
    let calls = ref.calls;
    const seen = new Set();
    node = this.unwrap(node);
    while (ts.isIdentifier(node)) {
      const key = file.scopeId + ":" + node.text;
      if (seen.has(key)) this.fail(node, "Cyclic registry reference");
      seen.add(key);
      const binding = this.binding(file, node.text);
      ({ file, node } = binding);
      calls = binding.calls ?? calls;
      node = this.unwrap(node);
    }
    return { file, node, ...(calls ? { calls } : {}) };
  }

  properties(ref) {
    const { file, node } = this.dereference(ref);
    if (!ts.isObjectLiteralExpression(node)) this.fail(node, "Expected a literal registry object");
    const key = file.scopeId + ":" + node.pos;
    if (this.resolving.has(key)) this.fail(node, "Cyclic registry spread");
    this.resolving.add(key);
    const out = new Map();
    try {
      for (const p of node.properties) {
        if (ts.isSpreadAssignment(p)) {
          for (const [name, value] of this.properties({ file, node: p.expression })) {
            if (out.has(name)) this.fail(p, `Duplicate registry key ${name}`);
            out.set(name, value);
          }
        } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
          const name = ts.isComputedPropertyName(p.name) ? this.value({ file, node: p.name.expression }) : p.name.text;
          if (typeof name !== "string") this.fail(p, "Non-string registry property");
          if (out.has(name)) this.fail(p, `Duplicate registry key ${name}`);
          out.set(name, { file, node: ts.isPropertyAssignment(p) ? p.initializer : p.name });
        } else if (ts.isMethodDeclaration(p)) out.set(p.name.text, { file, node: p });
        else this.fail(p, "Unsupported registry property");
      }
    } finally { this.resolving.delete(key); }
    return out;
  }

  value(ref, seen = new Set()) {
    const { file, node: raw } = ref;
    const node = this.unwrap(raw);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined" && !this.bindingScope(file, node.text)) return undefined;
      const key = file.scopeId + ":" + node.text;
      if (seen.has(key)) this.fail(node, "Cyclic registry value");
      return this.value(this.binding(file, node.text), new Set([...seen, key]));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return this.value({ file, node: node.left }, seen) + this.value({ file, node: node.right }, seen);
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) text += String(this.value({ file, node: span.expression }, seen)) + span.literal.text;
      return text;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((n) => {
      if (!ts.isSpreadElement(n)) return [this.value({ file, node: n }, seen)];
      const array = this.value({ file, node: n.expression }, seen);
      if (!Array.isArray(array)) this.fail(n, "Expected a literal registry array");
      return array;
    });
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries([...this.properties({ file, node })].map(([k, v]) => [k, this.value(v, seen)]));
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Set" && node.arguments?.length === 1) return this.value({ file, node: node.arguments[0] }, seen);
    this.fail(node, "Unsupported computed metadata; use a literal value or a local constant");
  }

  fields(ref, names) {
    const props = this.properties(ref);
    return Object.fromEntries(names.filter((n) => props.has(n)).map((n) => [n, this.value(props.get(n))]));
  }

  items(ref, seen = new Set()) {
    const { file, node } = this.dereference(ref);
    if (!ts.isArrayLiteralExpression(node)) this.fail(node, "Expected a literal registry array");
    const key = file.scopeId + ":" + node.pos;
    if (seen.has(key)) this.fail(node, "Cyclic registry array spread");
    const next = new Set([...seen, key]);
    return node.elements.flatMap((item) => ts.isSpreadElement(item)
      ? this.items({ file, node: item.expression }, next) : [{ file, node: item }]);
  }

  location(ref) {
    const { file, node } = this.dereference(ref);
    return { file: relative(this.root, file.filename).replaceAll("\\", "/"), line: file.ast.getLineAndCharacterOfPosition(node.getStart()).line + 1 };
  }

  flow(ref, seen = new Set()) {
    const property = this.flowProperty(ref, seen);
    return property ? this.value(property) : null;
  }

  flowProperty(ref, seen = new Set(), calls = new Set()) {
    const resolved = this.dereference(ref);
    const { file, node } = resolved;
    calls = resolved.calls ?? calls;
    const key = file.scopeId + ":" + node.pos;
    if (seen.has(key)) this.fail(node, "Cyclic OAuth provider");
    const next = new Set([...seen, key]);
    if (ts.isObjectLiteralExpression(node)) {
      // Flow overrides on the outer provider take precedence over a shared implementation.
      for (const p of [...node.properties].reverse()) {
        if (p.name) {
          const name = ts.isComputedPropertyName(p.name) ? this.value({ file, node: p.name.expression }) : p.name.text;
          if (name === "flowType") {
            if (ts.isPropertyAssignment(p)) return { file, node: p.initializer };
            if (ts.isShorthandPropertyAssignment(p)) return { file, node: p.name };
            this.fail(p, "OAuth flowType must be a static property");
          }
        }
        if (ts.isSpreadAssignment(p)) {
          const result = this.flowProperty({ file, node: p.expression }, next, calls);
          if (result) return result;
        }
      }
      return null;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callKey = file.filename + ":" + node.pos;
      if (calls.has(callKey)) this.fail(node, "Cyclic OAuth provider");
      const activeCalls = new Set([...calls, callKey]);
      if (node.arguments.some(ts.isSpreadElement)) this.fail(node, "Unsupported OAuth factory spread argument");
      const factory = this.dereference(this.binding(file, node.expression.text));
      if (!ts.isFunctionDeclaration(factory.node) || !factory.node.body) this.fail(node, "Unsupported OAuth factory");
      const returns = factory.node.body.statements.filter(ts.isReturnStatement);
      if (returns.length !== 1 || !returns[0].expression || factory.node.body.statements.length !== 1) this.fail(node, "OAuth factory must return a statically readable object");
      // Module bindings keep their defining scope instead of capturing factory parameters.
      const scope = { ...factory.file, scopeId: ++this.scopeSerial, bindings: new Map(), parent: factory.file };
      for (const param of factory.node.parameters) {
        if (!ts.isIdentifier(param.name) || param.dotDotDotToken) this.fail(param, "Unsupported OAuth factory parameter binding");
        scope.bindings.set(param.name.text, { unsupported: `Uninitialized OAuth factory parameter ${param.name.text}` });
      }
      for (let i = 0; i < factory.node.parameters.length; i++) {
        const param = factory.node.parameters[i];
        const argument = node.arguments[i];
        // Arguments precede the invocation; following one resumes the caller's call chain.
        let reference = argument ? { file, node: argument, calls } : null;
        if (param.initializer && (!reference || this.isUndefined(reference))) {
          // A default can see earlier parameters, but later parameters remain uninitialized.
          const defaults = { ...scope, scopeId: ++this.scopeSerial, bindings: new Map(scope.bindings) };
          reference = { file: defaults, node: param.initializer, calls: activeCalls };
        }
        scope.bindings.set(param.name.text, reference ? { reference } : { missing: true, unsupported: `Unresolved OAuth factory parameter ${param.name.text}` });
      }
      return this.flowProperty({ file: scope, node: returns[0].expression }, next, activeCalls);
    }
    this.fail(node, "Unsupported OAuth provider definition");
  }
}
