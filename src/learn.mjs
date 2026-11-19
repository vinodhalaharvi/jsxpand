// Learns how components are used from a folder of .tsx files:
//   edges[parent][child]   how often child appears directly inside parent
//   comps[name]            module, props, text, child sequences, wrappers, render props
// Lowercase elements (div, form, p) and {expressions} are see-through: a
// component inside them counts as a child of the nearest component above.
import ts from "typescript";
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, posix, sep, dirname, resolve } from "node:path";

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
  const add = (kind, node, declares, pos, propNames = []) => {
    const text = node.getText(sf);
    const uses = freeNames(node).filter((n) => !declares.includes(n));
    const needs = uses.filter((n) => n in imports && !isComp(n));
    const key = declares.length ? declares.join(",") : "effect:" + uses.sort().join(",");
    const d = (model.decls[key] ??= { kind, declares, variants: {} });
    const v = (d.variants[text] ??= { n: 0, uses, imports: Object.fromEntries(needs.map((n) => [n, imports[n]])), pos: 0 });
    v.n++;
    v.pos += pos;
    // names it reads that its component was given as props: they come in as props again
    const fp = uses.filter((n) => propNames.includes(n));
    if (fp.length) v.fromProps = fp;
    // the zod schema's fields, by name, for building a schema from the fields asked for
    ts.forEachChild(node, function find(m) {
      if (ts.isCallExpression(m) && m.expression.getText(sf) === "z.object" && m.arguments[0] && ts.isObjectLiteralExpression(m.arguments[0])) {
        for (const p of m.arguments[0].properties)
          if (ts.isPropertyAssignment(p)) {
            const f = p.name.getText(sf);
            const def = p.initializer.getText(sf);
            (model.fields[f] ??= {})[def] = (model.fields[f][def] ?? 0) + 1;
          }
        return;
      }
      ts.forEachChild(m, find);
    });
  };
  for (const st of sf.statements) {
    const isComponentConst = ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && /^[A-Z]/.test(d.name.getText(sf)));
    if (ts.isVariableStatement(st) && !isComponentConst && !st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      add("module", st, st.declarationList.declarations.flatMap((d) => bindingNames(d.name)), 0);
    else if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) add("module", st, [st.name.text], 0);
    let fn = ts.isFunctionDeclaration(st) && st.body ? st : null;
    if (!fn && ts.isVariableStatement(st)) {
      const d = st.declarationList.declarations[0];
      const init = d?.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isBlock(init.body) && /^[A-Z]/.test(d.name.getText(sf))) fn = init;
    }
    if (!fn) continue;
    // props: each destructured name with its type
    const p0 = fn.parameters[0];
    const propNames = p0 && ts.isObjectBindingPattern(p0.name) ? p0.name.elements.map((e) => e.name.getText(sf)) : [];
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
      if (ts.isVariableStatement(x)) add("local", x, x.declarationList.declarations.flatMap((d) => bindingNames(d.name)), pos, propNames);
      else if (ts.isFunctionDeclaration(x) && x.name) add("local", x, [x.name.text], pos, propNames);
      else if (ts.isExpressionStatement(x)) add("local", x, [], pos, propNames);
    });
  }
}

// Every .tsx file under dir, except the component library itself (its files
// define components rather than use them), tests and generated files.
function tsxFiles(dir, skip = ["components/ui/", ".test.", ".gen.", "routeTree"]) {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (f !== "node_modules" && !f.startsWith(".")) walk(p); continue; }
      const rel = relative(dir, p);
      if (f.endsWith(".tsx") && !skip.some((s) => rel.includes(s))) out.push(rel);
    }
  };
  walk(dir);
  return out;
}

export function learn(dir) {
  const model = { files: 0, edges: {}, comps: {}, decls: {}, imports: {}, exprUses: {}, fields: {} };
  const comp = (n) => (model.comps[n] ??= { count: 0, module: null, props: {}, text: {}, seqs: {}, wrapper: {}, render: null });
  const bump = (o, k, by = 1) => (o[k] = (o[k] ?? 0) + by);
  // with the project's types at hand (its node_modules installed), the learner also reads what each
  // component requires; without them it learns from usage alone
  const root = dirname(resolve(dir));
  const typed = existsSync(join(root, "node_modules/react"));
  const program = typed
    ? ts.createProgram(tsxFiles(dir).map((f) => join(dir, f)), {
        jsx: ts.JsxEmit.Preserve, strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, baseUrl: root, paths: { "@/*": [relative(root, resolve(dir)) + "/*"] },
        types: [],
      })
    : null;
  const checker = program?.getTypeChecker();
  const importedSomewhere = new Set();
  for (const f of tsxFiles(dir)) {
    const sf = ts.createSourceFile(f, readFileSync(join(dir, f), "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    for (const s of sf.statements)
      if (ts.isImportDeclaration(s) && s.importClause) {
        if (s.importClause.name) importedSomewhere.add(s.importClause.name.text);
        const nb = s.importClause.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) importedSomewhere.add(e.name.text);
      }
  }
  for (const f of tsxFiles(dir)) {
    const src = readFileSync(join(dir, f), "utf8");
    const sf = program?.getSourceFile(join(dir, f)) ?? ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    model.files++;
    const imports = {};
    // the way a name is imported most often wins: import { z } from "zod" over import z from "zod"
    const seen = (name, from) => {
      const c = ((model.importCounts ??= {})[name] ??= {});
      c[from] = (c[from] ?? 0) + 1;
      model.imports[name] = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
    };
    // a relative import is written from the project root ("../auth-layout" → "@/features/auth/auth-layout"),
    // so it still resolves from wherever the generated code ends up
    const from = (s) => {
      const m = s.moduleSpecifier.text;
      return m.startsWith(".") ? "@/" + posix.normalize(posix.join(posix.dirname(f.split(sep).join("/")), m)) : m;
    };
    sf.statements.forEach((s) => {
      // a default import is recorded as "default:<module>"
      if (ts.isImportDeclaration(s) && s.importClause?.name && !s.importClause.isTypeOnly) {
        imports[s.importClause.name.text] = "default:" + from(s);
        seen(s.importClause.name.text, "default:" + from(s));
      }
      // a renamed one as "<module>#<exported name>": import { Root as Radio } from "@radix-ui/react-radio-group"
      if (ts.isImportDeclaration(s) && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings))
        for (const e of s.importClause.namedBindings.elements) {
          const spec = from(s) + (e.propertyName ? "#" + e.propertyName.text : "");
          imports[e.name.text] = spec;
          if (!isComp(e.name.text) || !from(s).startsWith("@/components/")) seen(e.name.text, spec);
        }
    });
    learnDecls(sf, model, imports);
    // the names an expression reads, and where this file imports them from: two features can each
    // have their own `users`, and the expression goes with the one its file used
    // (kept per component too: <NewChat users={users} /> reads the chats' users, <UsersTable data={users} /> the other)
    const noteUses = (key, node, comp) => {
      const names = freeNames(node);
      model.exprUses[key] = names;
      for (const n of names)
        // "@local" when the file declared it itself (const users = conversations.map(...))
        for (const k of comp ? [key, comp + "|" + key] : [key]) ((model.exprImports ??= {})[k] ??= {})[n] = imports[n] ?? "@local";
    };
    // what the types say a component needs: props that must be given, and whether it takes children
    const typeInfo = (n, c) => {
      if (!checker || c.typed) return;
      const open = ts.isJsxElement(n) ? n.openingElement : n;
      const sig = checker.getResolvedSignature(open);
      const p0 = sig?.parameters?.[0];
      // a component taking no props at all (ThemeSwitch) takes no children either
      if (sig && !p0 && sig.declaration && !(sig.declaration.kind === ts.SyntaxKind.JSDocSignature)) { c.typed = true; c.required = []; c.leaf = true; return; }
      if (!p0) return;
      const t = checker.getTypeOfSymbolAtLocation(p0, open);
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
      const ps = checker.getPropertiesOfType(checker.getApparentType(t));
      if (!ps.length) return;
      c.typed = true;
      c.required = ps.filter((s) => !(s.flags & ts.SymbolFlags.Optional) && !["children", "key", "ref"].includes(s.name)).map((s) => s.name);
      if (!ps.some((s) => s.name === "children") && !ps.some((s) => s.name === "asChild")) c.leaf = true;
    };
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
    const visit = (n, parent, anc = []) => {
      // a file's own component that shares a name with an imported one (a local RadioGroupItem
      // beside the library's) is someone else's: looked through, not learned as that name
      if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && isComp(tagOf(n)) && !imports[tagOf(n)] && importedSomewhere.has(tagOf(n))) {
        ts.forEachChild(n, (m) => visit(m, parent, anc));
        return;
      }
      if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && isComp(tagOf(n))) {
        const name = tagOf(n);
        const c = comp(name);
        c.count++;
        // the family members it sits inside, anywhere above it: SelectTrigger inside Select
        const fam = name.split(/(?=[A-Z])/)[0];
        for (const a of new Set(anc)) if (a !== name && a.startsWith(fam)) (c.within ??= {})[a] = (c.within[a] ?? 0) + 1;
        if (ts.isJsxSelfClosingElement(n)) c.empty = (c.empty ?? 0) + 1;
        typeInfo(n, c);
        if (imports[name]) {
          const [m, as] = imports[name].replace(/^default:/, "").split("#");
          c.module = m;
          if (as) c.as = as;
          if (imports[name].startsWith("default:")) c.as = "default";
        }
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
              noteUses(v, e, name);
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
            noteUses("..." + a.expression.getText(sf), a.expression, name);
            continue;
          }
          const init = a.initializer;
          if (!init) sig.push([a.name.getText(sf), "true"]);
          else if (ts.isStringLiteral(init)) sig.push([a.name.getText(sf), JSON.stringify(init.text)]);
          else if (ts.isJsxExpression(init) && init.expression && !(ts.isArrowFunction(init.expression) && containsJsx(init.expression)))
          {
            sig.push([a.name.getText(sf), "{" + init.expression.getText(sf) + "}"]);
            noteUses("{" + init.expression.getText(sf) + "}", init.expression, name);
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
            noteUses(w, o.attributes);
          }
        }
        // the whole inside of this use, lowercase elements and text included, so a filled-in
        // component can look like a real one (the numbers in a stat card, the grid around cards)
        if (ts.isJsxElement(n)) {
          const items = skel(n.children, 0);
          const shape = JSON.stringify(shapeOf(items));
          const sk = ((c.skels ??= {})[parent] ??= {});
          (sk[shape] ??= { n: 0, sample: items }).n++;
        }
        for (const k of ks) visit(k, name, [...anc, name]);
        // components inside render props belong to this component too
        for (const a of attrsOf(n).properties)
          if (ts.isJsxAttribute(a) && a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression && ts.isArrowFunction(a.initializer.expression)) {
            const inner = [];
            const walk = (m) => { if ((ts.isJsxElement(m) || ts.isJsxSelfClosingElement(m)) && isComp(tagOf(m))) { inner.push(m); return; } ts.forEachChild(m, walk); };
            walk(a.initializer.expression);
            const rs = (c.renderSeqs ??= {});
            bump(rs, inner.map(tagOf).join(","));
            for (const k of inner) visit(k, name, [...anc, name]);
          }
        return;
      }
      ts.forEachChild(n, (m) => visit(m, parent, anc));
    };
    // children as data: { t } text, { c } a component (filled in on its own), { tag, a, k } a lowercase element
    const skel = (children, depth) => {
      const out = [];
      for (const ch of children) {
        if (out.length >= 12) break;
        if (ts.isJsxText(ch)) {
          const t = ch.text.replace(/\s+/g, " ").trim();
          if (t) out.push({ t });
        } else if (ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch)) {
          const tag = tagOf(ch);
          if (isComp(tag)) { out.push({ c: tag }); continue; }
          // <item.icon />: a value from the code around it, not markup to copy
          if (tag.includes(".")) continue;
          if (depth >= 4) continue;
          const a = [];
          for (const at of attrsOf(ch).properties) {
            if (!ts.isJsxAttribute(at)) continue;
            const k = at.name.getText(sf), init = at.initializer;
            if (!init) a.push([k, "true"]);
            else if (ts.isStringLiteral(init)) a.push([k, JSON.stringify(init.text)]);
            else if (ts.isJsxExpression(init) && init.expression && !containsJsx(init.expression)) {
              const v = "{" + init.expression.getText(sf) + "}";
              noteUses(v, init.expression);
              a.push([k, v]);
            }
          }
          out.push({ tag, a, k: ts.isJsxElement(ch) ? skel(ch.children, depth + 1) : [] });
        }
      }
      return out;
    };
    const shapeOf = (items) => items.map((x) => (x.t !== undefined ? "t" : x.c ? x.c : { [x.tag]: shapeOf(x.k) }));
    const containsJsx = (n) => { let f = false; const w = (m) => { if (f) return; if (ts.isJsxElement(m) || ts.isJsxSelfClosingElement(m) || ts.isJsxFragment(m)) f = true; else ts.forEachChild(m, w); }; w(n); return f; };
    // every outermost piece of JSX: returned, an arrow body, or a value; inner JSX is reached from it
    ts.forEachChild(sf, function find(m) {
      if (ts.isJsxElement(m) || ts.isJsxSelfClosingElement(m) || ts.isJsxFragment(m)) visit(m, ROOT);
      else ts.forEachChild(m, find);
    });
  }
  return model;
}

if (process.argv[2]) {
  const m = learn(process.argv[2]);
  writeFileSync(process.argv[3], JSON.stringify(m, null, 1));
  const n = Object.values(m.edges).reduce((a, e) => a + Object.values(e).reduce((x, y) => x + y, 0), 0);
  console.log(`${m.files} files, ${Object.keys(m.comps).length} components, ${n} parent→child uses`);
}
