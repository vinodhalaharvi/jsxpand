// Learns how components are used from a folder of .tsx files:
//   edges[parent][child]   how often child appears directly inside parent
//   comps[name]            module, props, text, child sequences, wrappers, render props
// Lowercase elements (div, form, p) and {expressions} are see-through: a
// component inside them counts as a child of the nearest component above.
import ts from "typescript";
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
    // names declared inside a block are its own (const id = ... in a callback is not a free name),
    // as are a for loop's and a catch clause's
    if (ts.isBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      const b = new Set(bound);
      for (const st of n.statements) {
        if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach((d) => bindingNames(d.name).forEach((x) => b.add(x)));
        else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) b.add(st.name.text);
      }
      ts.forEachChild(n, (m) => walk(m, b));
      return;
    }
    if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
      const b = new Set(bound);
      n.initializer.declarations.forEach((d) => bindingNames(d.name).forEach((x) => b.add(x)));
      ts.forEachChild(n, (m) => walk(m, b));
      return;
    }
    if (ts.isCatchClause(n)) {
      const b = new Set(bound);
      if (n.variableDeclaration) bindingNames(n.variableDeclaration.name).forEach((x) => b.add(x));
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

/**
 * Learns a model from the .tsx files under dir.
 * root: the project root (where node_modules is). alias: how the project writes imports from
 * its own tree ({ prefix: "@/", target: "<abs dir>" } for "@/*" → "./src/*"); without one,
 * imports are written "~root/<path from root>" and made relative where the code lands.
 */
export function learn(dir, opts = {}) {
  const model = { files: 0, edges: {}, comps: {}, decls: {}, imports: {}, exprUses: {}, fields: {} };
  const comp = (n) => (model.comps[n] ??= { count: 0, module: null, props: {}, text: {}, seqs: {}, wrapper: {}, render: null });
  const bump = (o, k, by = 1) => (o[k] = (o[k] ?? 0) + by);
  // with the project's types at hand (its node_modules installed), the learner also reads what each
  // component requires; without them it learns from usage alone
  const root = resolve(opts.root ?? dirname(resolve(dir)));
  const alias = opts.alias === undefined ? { prefix: "@/", target: resolve(dir) } : opts.alias;
  const typed = existsSync(join(root, "node_modules/react"));
  // the project's own compiler options and declaration files when given (the editor passes them), else a guess
  // the modules the project imports, for which entry points of a large package to read
  const imported = new Set();
  if (typed)
    for (const f of tsxFiles(dir, [])) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/from\s+["']([^"'.][^"']*)["']/g)) imported.add(m[1]);
    }
  const entries = typed ? entryPoints(root, opts.compilerOptions ?? {}, imported) : [];
  const componentFiles = tsxFiles(dir, [".test.", ".gen.", "routeTree"]).map((f) => join(dir, f));
  const program = typed && opts.compilerOptions
    ? ts.createProgram([...componentFiles, ...(opts.declarations ?? []), ...entries.map((e) => e.file)], { ...opts.compilerOptions, noEmit: true, incremental: false, tsBuildInfoFile: undefined })
    : typed
    ? ts.createProgram(tsxFiles(dir).map((f) => join(dir, f)), {
        jsx: ts.JsxEmit.Preserve, strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, baseUrl: root,
        // (an alias for the root itself, "@/*" → "./*", must not become "/*")
        paths: alias ? { [alias.prefix + "*"]: [(relative(root, alias.target) || ".") + "/*"] } : {},
        types: [],
      })
    : null;
  const checker = program?.getTypeChecker();
  // whether the types were read in full: TypeScript's own library has to have been found
  // (bundled, it looks beside the bundle; without it Omit, Partial and the DOM read as any)
  model.types = program ? { checked: true, lib: program.getSourceFiles().some((f) => program.isSourceFileDefaultLibrary(f)) } : { checked: false, lib: false };
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
      if (!m.startsWith(".")) return m;
      const abs = resolve(dir, dirname(f), m);
      const rel = (a, b) => relative(a, b).split(sep).join("/");
      return alias && !rel(alias.target, abs).startsWith("..") ? alias.prefix + rel(alias.target, abs) : "~root/" + rel(root, abs);
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
  if (checker) learnExports(model, program, checker, { root, alias, componentFiles, entries });
  return model;
}

/**
 * The public entry points of the project's dependencies, as each package declares them in its
 * package.json "exports" (or "types"): "next/link", "lucide-react", "@radix-ui/react-select".
 * Anything a package does not export there is internal to it.
 */
function entryPoints(root, options, imported = new Set()) {
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); } catch { return []; }
  const out = [];
  const from = join(root, "index.tsx");
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    let specs = [dep];
    try {
      const own = JSON.parse(readFileSync(join(root, "node_modules", dep, "package.json"), "utf8"));
      // only a package that depends on React can export a component (zod, date-fns, axios cannot)
      const needs = { ...own.dependencies, ...own.peerDependencies };
      if (dep !== "react" && !needs.react && !needs["react-dom"] && !needs["@types/react"]) continue;
      if (own.exports && typeof own.exports === "object" && !Array.isArray(own.exports)) {
        const subs = Object.keys(own.exports).filter((k) => k.startsWith(".") && !k.includes("*") && !/\.(json|css|[cm]?js)$/.test(k));
        // its main entry, and the other entry points the project imports from (next/link): a package's
        // other entries can each re-declare all of it (lucide's dynamic.d.ts is another 3 MB of icons)
        specs = subs.filter((k) => k === "." || imported.has(dep + k.slice(1))).map((k) => (k === "." ? dep : dep + k.slice(1)));
      }
    } catch { /* not installed */ }
    for (const spec of specs) {
      const r = ts.resolveModuleName(spec, from, options, ts.sys).resolvedModule;
      if (r?.resolvedFileName && /\.d\.[cm]?ts$|\.tsx?$/.test(r.resolvedFileName)) out.push({ spec, file: r.resolvedFileName });
    }
  }
  return out;
}

/**
 * Every component the project can use, used yet or not: what its own files export (components/ui
 * included) and what its dependencies' entry points export. Ones never used get a count of 0: they
 * are offered, at the bottom, with what their types require.
 */
function learnExports(model, program, checker, { root, alias, componentFiles, entries }) {
  const rel = (a, b) => relative(a, b).split(sep).join("/");
  const specFor = (file) => {
    const noExt = file.replace(/\.[jt]sx?$/, "").replace(/\/index$/, "");
    return alias && !rel(alias.target, noExt).startsWith("..") ? alias.prefix + rel(alias.target, noExt) : "~root/" + rel(root, noExt);
  };
  const sources = [...componentFiles.map((f) => ({ spec: specFor(f), file: f, own: true })), ...entries.map((e) => ({ ...e, own: false }))];
  // one name per thing exported: lucide exports each icon as Activity, ActivityIcon and LucideActivity,
  // @radix-ui/react-dialog its portal as Portal and DialogPortal. The most distinctive name stands for
  // it: the one the fewest modules export (DialogPortal over Portal), then the shortest (Activity)
  const exportsOf = new Map();
  const modulesNaming = new Map();
  for (const src of sources) {
    const sf = program.getSourceFile(src.file);
    const mod = sf && checker.getSymbolAtLocation(sf);
    const exps = mod ? checker.getExportsOfModule(mod) : [];
    exportsOf.set(src, exps);
    for (const e of new Set(exps.map((x) => x.name))) modulesNaming.set(e, (modulesNaming.get(e) ?? 0) + 1);
  }
  for (const src of sources) {
    const { spec, own } = src;
    const named = new Map();
    for (const exp of exportsOf.get(src)) {
      const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
      const decl = sym.valueDeclaration ?? sym.declarations?.[0];
      const key = decl ? decl.getSourceFile().fileName + ":" + decl.pos : exp.name;
      const had = named.get(key);
      const rank = (e) => [modulesNaming.get(e.name) ?? 1, e.name.length];
      if (!had) { named.set(key, exp); continue; }
      const [a1, a2] = rank(exp), [b1, b2] = rank(had);
      if (a1 < b1 || (a1 === b1 && a2 < b2)) named.set(key, exp);
    }
    for (const exp of named.values()) {
      const name = exp.name;
      if (!/^[A-Z]/.test(name)) continue;
      const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
      if (!(sym.flags & ts.SymbolFlags.Value)) continue;
      const decl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (!decl) continue;
      // @internal: the library says it is not for you
      if ([decl, ...(ts.isVariableDeclaration(decl) ? [decl.parent.parent] : [])].some((d) => ts.getJSDocTags(d).some((t) => t.tagName.text === "internal"))) continue;
      const t = checker.getTypeOfSymbolAtLocation(sym, decl);
      const sig = t.getCallSignatures()[0] ?? t.getConstructSignatures()[0];
      if (!sig) continue;
      // a component: a function returning something React renders, or a class with render() and props
      // (zod's ZodString is a class too, but not a component)
      if (t.getCallSignatures()[0]) {
        const ret = sig.getReturnType();
        const renders = /Element|ReactNode|ReactPortal|JSX/.test(checker.typeToString(ret));
        // where the return type cannot be read, the library's own word: a @component tag, or a type named
        // as one (lucide's icons are LucideIcon = ForwardRefExoticComponent, each tagged @component)
        const unread = ret.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown);
        const declares = unread && ([decl, ...(ts.isVariableDeclaration(decl) ? [decl.parent.parent] : [])].some((d) => ts.getJSDocTags(d).some((x) => x.tagName.text === "component")) || /Component|\bFC\b|Icon\b/.test(checker.typeToString(t)));
        if (!renders && !declares) continue;
      } else {
        const inst = sig.getReturnType();
        if (!inst.getProperty("render") || !inst.getProperty("props")) continue;
      }
      if (sig.parameters.length > 2) continue;
      const known = model.comps[name];
      // the same name from somewhere else: the one in use stays, else the first found
      // (the project's own files come first: its Select, not @radix-ui's)
      if (known && ((known.module && known.module !== spec && known.count > 0) || known.exported)) continue;
      const c = known ?? (model.comps[name] = { count: 0, module: spec, props: {}, text: {}, seqs: {}, wrapper: {}, render: null, byParent: {} });
      c.module ??= spec;
      c.exported = own ? "project" : "package";
      if (c.typed) continue;
      const p0 = sig.parameters[0];
      c.typed = true;
      if (!p0) { c.required = []; c.leaf = true; continue; }
      const pt = checker.getApparentType(checker.getTypeOfSymbolAtLocation(p0, decl));
      const ps = checker.getPropertiesOfType(pt);
      c.required = ps.filter((s) => !(s.flags & ts.SymbolFlags.Optional) && !["children", "key", "ref"].includes(s.name)).map((s) => s.name);
      if (!ps.some((s) => s.name === "children" || s.name === "asChild")) c.leaf = true;
      // a value for each required prop: a literal its type allows, or a name the code around it supplies
      c.reqVals = {};
      for (const r of c.required) {
        const s = ps.find((x) => x.name === r);
        const rt = s && checker.getTypeOfSymbolAtLocation(s, decl);
        let v = `{${/^[a-z_$][\w$]*$/i.test(r) ? r : "undefined"}}`;
        if (rt) {
          const lits = (rt.isUnion() ? rt.types : [rt]).filter((x) => x.isStringLiteral());
          if (lits.length) v = JSON.stringify(lits[0].value);
          else if (rt.flags & ts.TypeFlags.String) v = '""';
          else if (rt.flags & ts.TypeFlags.Number) v = "{0}";
          else if (rt.flags & ts.TypeFlags.Boolean) v = "{false}";
        }
        c.reqVals[r] = v;
        if (v.startsWith("{") && v !== "{undefined}" && !/^\{(0|false)\}$/.test(v)) model.exprUses[v] = [v.slice(1, -1)];
      }
    }
  }
}

// run as a script (node src/learn.mjs <dir> <out.json>), and only then: bundled into something
// else (the editor extension), this module must not read that program's arguments
if (import.meta.url && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2]) {
  const m = learn(process.argv[2]);
  writeFileSync(process.argv[3], JSON.stringify(m, null, 1));
  const n = Object.values(m.edges).reduce((a, e) => a + Object.values(e).reduce((x, y) => x + y, 0), 0);
  console.log(`${m.files} files, ${Object.keys(m.comps).length} components, ${n} parent→child uses`);
}
