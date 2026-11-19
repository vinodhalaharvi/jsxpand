// Learns how components are used from a folder of .tsx files:
//   edges[parent][child]   how often child appears directly inside parent
//   comps[name]            module, props, text, child sequences, wrappers, render props
// Lowercase elements (div, form, p) and {expressions} are see-through: a
// component inside them counts as a child of the nearest component above.
import ts from "typescript";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "ROOT";
const isComp = (n) => /^[A-Z]/.test(n);

// Names an expression reads that it does not bind itself: form and onSubmit in
// form.handleSubmit(onSubmit), but not handleSubmit, and not e in (e) => e.x.
export function freeNames(node) {
  const out = new Set();
  const walk = (n, bound) => {
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) {
      const b = new Set(bound);
      n.parameters.forEach((p) => bindingNames(p.name).forEach((x) => b.add(x)));
      ts.forEachChild(n, (m) => walk(m, b));
      return;
    }
    if (ts.isPropertyAccessExpression(n)) { walk(n.expression, bound); return; }
    if (ts.isPropertyAssignment(n)) { walk(n.initializer, bound); return; }
    if (ts.isJsxAttribute(n)) { if (n.initializer) walk(n.initializer, bound); return; }
    if (ts.isTypeReferenceNode(n) || ts.isTypeQueryNode(n)) {
      const id = ts.isTypeReferenceNode(n) ? n.typeName : n.exprName;
      const first = ts.isIdentifier(id) ? id.text : leftmost(id);
      if (first && !bound.has(first)) out.add(first);
      (n.typeArguments ?? []).forEach((m) => walk(m, bound));
      return;
    }
    if (ts.isPropertySignature(n)) { if (n.type) walk(n.type, bound); return; }
    if (ts.isIdentifier(n)) { if (!bound.has(n.text) && !GLOBALS.has(n.text)) out.add(n.text); return; }
    ts.forEachChild(n, (m) => walk(m, bound));
  };
  walk(node, new Set());
  return [...out];
}
const leftmost = (q) => (ts.isIdentifier(q) ? q.text : leftmost(q.left));
const GLOBALS = new Set(["console", "fetch", "JSON", "Math", "Date", "Promise", "undefined", "window", "document", "Array", "Object", "String", "Number", "Boolean", "setTimeout"]);
function bindingNames(b) {
  if (ts.isIdentifier(b)) return [b.text];
  return b.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

// Declarations, keyed by the names they declare: module-level consts and types,
// a component's props, and the statements in its body (hooks, handlers, effects).
function learnDecls(sf, model, imports) {
  const add = (kind, node, declares, pos) => {
    const text = node.getText(sf);
    const uses = freeNames(node).filter((n) => !declares.includes(n));
    const needs = uses.filter((n) => n in imports && !isComp(n));
    const key = declares.length ? declares.join(",") : "effect:" + uses.sort().join(",");
    const d = (model.decls[key] ??= { kind, declares, variants: {} });
    const v = (d.variants[text] ??= { n: 0, uses, imports: Object.fromEntries(needs.map((n) => [n, imports[n]])), pos: 0 });
    v.n++;
    v.pos += pos;
    // the zod schema's fields, by name, for building a schema from the fields asked for
    if (/z\.object\(/.test(text))
      text.replace(/\b([a-zA-Z]\w*): (z\.[^,\n]+),?\n/g, (_, f, def) => ((model.fields[f] ??= {})[def] = ((model.fields[f] ??= {})[def] ?? 0) + 1, ""));
  };
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && !st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      add("module", st, st.declarationList.declarations.flatMap((d) => bindingNames(d.name)), 0);
    else if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) add("module", st, [st.name.text], 0);
    const fn = ts.isFunctionDeclaration(st) && st.body ? st : null;
    if (!fn) continue;
    // props: each destructured name with its type
    const p0 = fn.parameters[0];
    if (p0 && ts.isObjectBindingPattern(p0.name)) {
      const types = {};
      if (p0.type && ts.isTypeLiteralNode(p0.type))
        for (const m of p0.type.members) if (ts.isPropertySignature(m) && m.type) types[m.name.getText(sf)] = m.type.getText(sf);
      for (const e of p0.name.elements) {
        const name = e.name.getText(sf);
        const d = (model.decls["prop:" + name] ??= { kind: "prop", declares: [name], variants: {} });
        const t = types[name] ?? "any";
        const v = (d.variants[t] ??= { n: 0, uses: [], imports: {}, pos: 0 });
        v.n++;
      }
    }
    const body = fn.body.statements.filter((x) => !ts.isReturnStatement(x));
    body.forEach((x, i) => {
      const pos = (i + 1) / (body.length + 1);
      if (ts.isVariableStatement(x)) add("local", x, x.declarationList.declarations.flatMap((d) => bindingNames(d.name)), pos);
      else if (ts.isFunctionDeclaration(x) && x.name) add("local", x, [x.name.text], pos);
      else if (ts.isExpressionStatement(x)) add("local", x, [], pos);
    });
  }
}

export function learn(dir) {
  const model = { files: 0, edges: {}, comps: {}, decls: {}, imports: {}, exprUses: {}, fields: {} };
  const comp = (n) => (model.comps[n] ??= { count: 0, module: null, props: {}, text: {}, seqs: {}, wrapper: {}, render: null });
  const bump = (o, k, by = 1) => (o[k] = (o[k] ?? 0) + by);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".tsx")).sort()) {
    const src = readFileSync(join(dir, f), "utf8");
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    model.files++;
    const imports = {};
    sf.statements.forEach((s) => {
      if (ts.isImportDeclaration(s) && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings))
        for (const e of s.importClause.namedBindings.elements) {
          imports[e.name.text] = s.moduleSpecifier.text;
          if (!isComp(e.name.text) || !s.moduleSpecifier.text.startsWith("@/components/")) model.imports[e.name.text] = s.moduleSpecifier.text;
        }
    });
    learnDecls(sf, model, imports);
    const tagOf = (n) => (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText(sf);
    const attrsOf = (n) => (ts.isJsxElement(n) ? n.openingElement : n).attributes;
    // the components found directly under a node, looking through lowercase elements and expressions
    const kids = (n) => {
      const out = [];
      const walk = (m) => {
        if (ts.isJsxElement(m) || ts.isJsxSelfClosingElement(m)) {
          if (isComp(tagOf(m))) { out.push(m); return; }
        }
        ts.forEachChild(m, walk);
      };
      if (ts.isJsxElement(n)) n.children.forEach(walk);
      return out;
    };
    const visit = (n, parent) => {
      if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && isComp(tagOf(n))) {
        const name = tagOf(n);
        const c = comp(name);
        c.count++;
        if (imports[name]) c.module = imports[name];
        bump((model.edges[parent] ??= {}), name);
        const pc = (c.byParent ??= {});
        bump(pc, parent);
        // props, overall and per parent: literal values, expressions, booleans, spreads
        const pb = ((c.propsBy ??= {})[parent] ??= {});
        const tb = ((c.textBy ??= {})[parent] ??= {});
        for (const a of attrsOf(n).properties) {
          if (ts.isJsxSpreadAttribute(a)) {
            const k = "..." + a.expression.getText(sf);
            (c.props[k] ??= { n: 0, vals: {} }).n++;
            (pb[k] ??= { n: 0, vals: {} }).n++;
            continue;
          }
          const key = a.name.getText(sf);
          const p = (c.props[key] ??= { n: 0, vals: {} });
          const q = (pb[key] ??= { n: 0, vals: {} });
          p.n++;
          q.n++;
          const init = a.initializer;
          let v;
          if (!init) v = "true";
          else if (ts.isStringLiteral(init)) v = JSON.stringify(init.text);
          else if (ts.isJsxExpression(init) && init.expression) {
            const e = init.expression;
            if (ts.isArrowFunction(e) && containsJsx(e)) {
              c.render = { prop: key, params: e.parameters.map((x) => x.getText(sf)).join(", ") };
              v = null;
            } else {
              v = "{" + e.getText(sf) + "}";
              model.exprUses[v] = freeNames(e);
            }
          }
          if (v) {
            bump(p.vals, v);
            bump(q.vals, v);
          }
        }
        // does this use show something inside it (text or an expression), apart from components?
        if (ts.isJsxElement(n) && n.children.some((x) => (ts.isJsxText(x) && x.text.trim()) || (ts.isJsxExpression(x) && x.expression && !containsJsx(x.expression)))) c.content = (c.content ?? 0) + 1;
        // the whole set of props on this use, so props are suggested as a combination seen together
        const sig = [];
        for (const a of attrsOf(n).properties) {
          if (ts.isJsxSpreadAttribute(a)) {
            sig.push(["..." + a.expression.getText(sf), null]);
            model.exprUses["..." + a.expression.getText(sf)] = freeNames(a.expression);
            continue;
          }
          const init = a.initializer;
          if (!init) sig.push([a.name.getText(sf), "true"]);
          else if (ts.isStringLiteral(init)) sig.push([a.name.getText(sf), JSON.stringify(init.text)]);
          else if (ts.isJsxExpression(init) && init.expression && !(ts.isArrowFunction(init.expression) && containsJsx(init.expression)))
          {
            sig.push([a.name.getText(sf), "{" + init.expression.getText(sf) + "}"]);
            model.exprUses["{" + init.expression.getText(sf) + "}"] = freeNames(init.expression);
          }
        }
        const text = ts.isJsxElement(n) ? n.children.filter(ts.isJsxText).map((x) => x.text.trim()).join(" ").trim() : "";
        bump(((c.sigs ??= {})[parent] ??= {}), JSON.stringify({ p: sig, t: text }));
        // literal text inside
        if (ts.isJsxElement(n)) {
          const t = n.children.filter(ts.isJsxText).map((x) => x.text.trim()).join(" ").trim();
          if (t) {
            bump(c.text, t);
            bump(tb, t);
          }
        }
        // the sequence of child components, per parent
        const ks = kids(n);
        if (ts.isJsxElement(n)) bump((c.seqs[parent] ??= {}), ks.map(tagOf).join(","));
        // one lowercase element wrapping everything
        if (ts.isJsxElement(n)) {
          const direct = n.children.filter((x) => !(ts.isJsxText(x) && !x.text.trim()));
          if (direct.length === 1 && ts.isJsxElement(direct[0]) && !isComp(tagOf(direct[0]))) {
            const o = direct[0].openingElement;
            const w = "<" + o.tagName.getText(sf) + (o.attributes.properties.length ? " " + o.attributes.getText(sf) : "") + ">";
            bump(c.wrapper, w);
            model.exprUses[w] = freeNames(o.attributes);
          }
        }
        for (const k of ks) visit(k, name);
        // components inside render props belong to this component too
        for (const a of attrsOf(n).properties)
          if (ts.isJsxAttribute(a) && a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression && ts.isArrowFunction(a.initializer.expression)) {
            const inner = [];
            const walk = (m) => { if ((ts.isJsxElement(m) || ts.isJsxSelfClosingElement(m)) && isComp(tagOf(m))) { inner.push(m); return; } ts.forEachChild(m, walk); };
            walk(a.initializer.expression);
            const rs = (c.renderSeqs ??= {});
            bump(rs, inner.map(tagOf).join(","));
            for (const k of inner) visit(k, name);
          }
        return;
      }
      ts.forEachChild(n, (m) => visit(m, parent));
    };
    const containsJsx = (n) => { let f = false; const w = (m) => { if (f) return; if (ts.isJsxElement(m) || ts.isJsxSelfClosingElement(m) || ts.isJsxFragment(m)) f = true; else ts.forEachChild(m, w); }; w(n); return f; };
    // only JSX returned from the file's components
    sf.statements.forEach((s) => ts.forEachChild(s, function find(m) {
      if (ts.isReturnStatement(m) && m.expression) visit(m.expression, ROOT);
      else ts.forEachChild(m, find);
    }));
  }
  return model;
}

if (process.argv[2]) {
  const m = learn(process.argv[2]);
  writeFileSync(process.argv[3], JSON.stringify(m, null, 1));
  const n = Object.values(m.edges).reduce((a, e) => a + Object.values(e).reduce((x, y) => x + y, 0), 0);
  console.log(`${m.files} files, ${Object.keys(m.comps).length} components, ${n} parent→child uses`);
}
