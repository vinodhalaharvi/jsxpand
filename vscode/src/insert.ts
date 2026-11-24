// Where an expansion goes in a file, and the edits that put it there. No VS Code in here:
// it works on text and offsets, so it is tested against real files.
import ts from "typescript";
import { posix } from "node:path";
import type { Parts } from "../../src/engine.js";

/** A replacement of text[start, end) by text. */
export type Edit = { start: number; end: number; text: string };

/** What the cursor is in: JSX (expand to elements) or the top level of a file (expand to a whole component). */
export type Where = { mode: "jsx" | "component"; start: number; end: number; abbrev: string; inside: string[] };

const ABBREV = /[A-Za-z][A-Za-z0-9>+^*.]*$/;

/**
 * The abbreviation ending at offset and what it is in, or null where an expansion makes no sense
 * (strings, comments, imports, ordinary expressions).
 */
export function locate(text: string, offset: number, fileName = "x.tsx"): Where | null {
  const m = ABBREV.exec(text.slice(Math.max(0, offset - 200), offset));
  if (!m || m[0].length < 2) return null;
  const abbrev = m[0];
  const start = offset - abbrev.length;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // the innermost node containing the abbreviation's first character
  let node: ts.Node = sf;
  const dive = (n: ts.Node): void => {
    n.forEachChild((c) => {
      if (c.getStart(sf) <= start && start < c.end) {
        node = c;
        dive(c);
      }
    });
  };
  dive(sf);
  // the elements around it, outermost first: <Main><Card>here → ["Main", "Card"]
  const inside: string[] = [];
  for (let n: ts.Node | undefined = node; n; n = n.parent)
    if (ts.isJsxElement(n) && n.openingElement.end <= start) inside.unshift(n.openingElement.tagName.getText(sf));
  // inside a string or a comment: nothing to do
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isTemplateLiteralToken(node)) return null;
  for (const r of [...(ts.getLeadingCommentRanges(text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(text, node.end) ?? [])])
    if (r.pos <= start && start < r.end) return null;
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isImportDeclaration(n)) return null;
    // text between tags: <Card>here</Card>
    if (ts.isJsxText(n) || ts.isJsxElement(n) || ts.isJsxFragment(n)) return { mode: "jsx", start, end: offset, abbrev, inside };
    // return (here) and return here
    if (ts.isReturnStatement(n) || (ts.isParenthesizedExpression(n) && n.parent && ts.isReturnStatement(n.parent)))
      return n.getStart(sf) < start ? { mode: "jsx", start, end: offset, abbrev, inside } : null;
    // an arrow returning it: () => here
    if (ts.isArrowFunction(n) && n.body.getStart(sf) <= start) return ts.isBlock(n.body) ? null : { mode: "jsx", start, end: offset, abbrev, inside };
    // a statement of its own at the top of the file: a new component
    if (ts.isExpressionStatement(n) && n.parent === sf) return { mode: "component", start, end: offset, abbrev, inside: [] };
    if (ts.isStatement(n) || ts.isSourceFile(n)) return null;
  }
  return null;
}

/** An empty spot for a child component: where, and the components around it. */
export type Slot = {
  /** where the inserted code starts (a "<" typed there is replaced) and ends */
  start: number;
  end: number;
  /** the nearest component around it, the one around that ("ROOT" at the top), and the component just before it inside the parent (null: none yet) */
  parent: string;
  grand: string;
  prev: string | null;
  /** the elements around it, outermost first, as locate gives them */
  inside: string[];
};

const isComp = (n: string) => /^[A-Z]/.test(n);
const tagName = (n: ts.Node, sf: ts.SourceFile): string | null =>
  ts.isJsxElement(n) ? n.openingElement.tagName.getText(sf) : ts.isJsxSelfClosingElement(n) ? n.tagName.getText(sf) : null;

/**
 * An empty spot between a component's tags, just after a typed "<" or on an empty line, or null
 * anywhere else (an abbreviation already typed, the top level of a return, a string, an attribute).
 */
export function slot(text: string, offset: number, fileName = "x.tsx"): Slot | null {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  let start: number;
  if (/(^|[\s>}])<$/.test(before)) start = offset - 1;
  else if (/^\s*$/.test(before)) start = offset;
  else return null;
  // read the file without the "<", so the tags around parse as they will be
  const clean = text.slice(0, start) + text.slice(offset);
  const sf = ts.createSourceFile(fileName, clean, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // the innermost element whose children hold the spot
  let host: ts.JsxElement | null = null;
  const dive = (n: ts.Node): void => {
    n.forEachChild((c) => {
      if (c.getStart(sf) <= start && start <= c.end) {
        if (ts.isJsxElement(c) && c.openingElement.end <= start && start <= c.closingElement.getStart(sf)) host = c;
        dive(c);
      }
    });
  };
  dive(sf);
  const found = host as ts.JsxElement | null;
  if (!found) return null;
  const inside: string[] = [];
  const comps: ts.JsxElement[] = [];
  for (let n: ts.Node | undefined = found; n; n = n.parent)
    if (ts.isJsxElement(n)) {
      inside.unshift(n.openingElement.tagName.getText(sf));
      if (isComp(n.openingElement.tagName.getText(sf))) comps.push(n);
    }
  // nothing to go on at the top level of a page: only inside a component
  const parentEl = comps[0];
  if (!parentEl) return null;
  // the component just before the spot among the parent's children, looking through lowercase
  // elements as the learner does
  let prev: string | null = null;
  const walk = (n: ts.Node): void => {
    const t = tagName(n, sf);
    if (t && isComp(t)) {
      if (n.end <= start) prev = t;
      return;
    }
    n.forEachChild(walk);
  };
  parentEl.children.forEach(walk);
  return { start, end: offset, parent: parentEl.openingElement.tagName.getText(sf), grand: comps[1]?.openingElement.tagName.getText(sf) ?? "ROOT", prev, inside };
}

/** Names declared by a binding: const { a, b: [c] } = ... → a, c */
function bindingNames(n: ts.BindingName): string[] {
  if (ts.isIdentifier(n)) return [n.text];
  return n.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

/** Names a statement declares at its own level. */
function declared(s: ts.Statement): string[] {
  if (ts.isVariableStatement(s)) return s.declarationList.declarations.flatMap((d) => bindingNames(d.name));
  if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) return [s.name.text];
  if (ts.isImportDeclaration(s) && s.importClause) {
    const c = s.importClause;
    const out = c.name ? [c.name.text] : [];
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) out.push(...c.namedBindings.elements.map((e) => e.name.text));
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) out.push(c.namedBindings.name.text);
    return out;
  }
  return [];
}

/**
 * The module a spec names, as this file should write it: "~root/x/y" is made relative to the file;
 * "default:" and "#exported" are taken off (they say how to import, not from where).
 */
export function moduleFor(spec: string, fileRel: string): { module: string; kind: "default" | "named"; exported?: string } {
  const isDefault = spec.startsWith("default:");
  const [m, exported] = (isDefault ? spec.slice(8) : spec).split("#");
  let module = m;
  if (m.startsWith("~root/")) {
    const rel = posix.relative(posix.dirname(fileRel), m.slice(6));
    module = rel.startsWith(".") ? rel : "./" + rel;
  }
  return { module, kind: isDefault ? "default" : "named", exported };
}

const indentOf = (text: string, at: number) => /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", at - 1) + 1))?.[0] ?? "";
const indent = (block: string, pad: string) => block.split("\n").map((l, i) => (i && l ? pad + l : l)).join("\n");

/**
 * The edits that put an expansion into a file: the JSX in place of the abbreviation, then each import,
 * declaration and prop where it belongs, leaving out whatever the file already has.
 * fileRel: the file's path from the project root, for relative imports.
 */
export function edits(text: string, where: Where, parts: Parts, fileRel: string): { main: Edit; extra: Edit[] } {
  const sf = ts.createSourceFile(fileRel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const extra: Edit[] = [];
  const pad = indentOf(text, where.start);

  // names in scope at the cursor: the file's top level, and every function around the cursor
  const top = new Set(sf.statements.flatMap(declared));
  const outer: ts.FunctionLikeDeclaration[] = [];
  const findFns = (n: ts.Node): void => {
    if (n.getStart(sf) <= where.start && where.start < n.end) {
      if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) outer.push(n);
      n.forEachChild(findFns);
    }
  };
  sf.forEachChild(findFns);
  const inScope = new Set(top);
  for (const f of outer) {
    for (const p of f.parameters) for (const n of bindingNames(p.name)) inScope.add(n);
    if (f.body && ts.isBlock(f.body)) for (const s of f.body.statements) for (const n of declared(s)) inScope.add(n);
  }

  if (where.mode === "component") {
    // a whole component in place of the abbreviation, with only the declarations and imports the file lacks
    const name = `${/<([A-Z]\w*)/.exec(parts.jsx)?.[1] ?? "My"}Example`;
    const mods = parts.module.filter((d) => d.declares.some((n) => !top.has(n)));
    const sig = parts.props.length ? `{ ${parts.props.map((p) => p.name).join(", ")} }: { ${parts.props.map((p) => `${p.name}: ${p.type}`).join("; ")} }` : "";
    const out = [
      ...mods.map((d) => d.text + "\n"),
      `export function ${name}(${sig}) {`,
      ...(parts.local.length ? [parts.local.map((d) => "  " + indent(d.text, "  ")).join("\n\n"), ""] : []),
      "  return (",
      parts.jsx.split("\n").map((l) => "    " + l).join("\n"),
      "  );",
      "}",
    ].join("\n");
    addImports(parts.imports, top);
    // an insertion at the abbreviation itself (imports into a file that has none) joins the main edit:
    // editors refuse edits that touch
    const main: Edit = { start: where.start, end: where.end, text: out };
    const touching = extra.filter((e) => e.start === where.start && e.end === where.start);
    main.text = touching.map((e) => e.text).join("") + main.text;
    return { main, extra: extra.filter((e) => !touching.includes(e)) };
  }

  // JSX in place of the abbreviation, its lines indented like the line it starts on
  const main: Edit = { start: where.start, end: where.end, text: indent(parts.jsx, pad) };

  // the component the cursor is in: the outermost function around it
  const comp = outer[0];
  const body = comp?.body && ts.isBlock(comp.body) ? comp.body : null;

  // hooks and other locals go first thing in the component; ones it already has are left out
  const locals = parts.local.filter((d) => d.declares.length === 0 ? !text.includes(d.text) : d.declares.some((n) => !inScope.has(n)));
  if (body && locals.length) {
    const bpad = indentOf(text, body.statements[0]?.getStart(sf) ?? body.getStart(sf)) || indentOf(text, body.getStart(sf)) + "  ";
    // first thing in the component, or after the last statement declaring a name they read
    // (const subscriptionPlan = await getUserSubscriptionPlan(user.id) goes after const user = ...)
    const reads = new Set(locals.flatMap((d) => d.uses ?? []));
    const before = body.statements.filter((st) => st.end <= where.start);
    // (mentions, not only declarations: a guard like if (!user) redirect() narrows what they read)
    const mentions = (st: ts.Node): boolean => {
      let hit = false;
      const walk = (n: ts.Node): void => {
        if (hit) return;
        if (ts.isIdentifier(n) && reads.has(n.text)) hit = true;
        else n.forEachChild(walk);
      };
      walk(st);
      return hit;
    };
    const dep = [...before].reverse().find(mentions);
    const at = dep ? dep.end : body.getStart(sf) + 1;
    extra.push({ start: at, end: at, text: (dep ? "\n\n" : "\n") + locals.map((d) => bpad + indent(d.text, bpad)).join("\n\n") + (dep ? "" : "\n") });
    for (const d of locals) for (const n of d.declares) inScope.add(n);
  }

  // module-level declarations (types, constants, schemas) just above the component
  const mods = parts.module.filter((d) => d.declares.some((n) => !top.has(n)));
  if (mods.length) {
    const stmt = sf.statements.find((s) => s.getStart(sf) <= where.start && where.start < s.end);
    const at = stmt ? stmt.getFullStart() + (text.slice(stmt.getFullStart(), stmt.getStart(sf)).match(/^\s*/)?.[0].length ?? 0) : where.start;
    extra.push({ start: at, end: at, text: mods.map((d) => d.text).join("\n\n") + "\n\n" });
    for (const d of mods) for (const n of d.declares) top.add(n);
  }

  // anything else the JSX reads comes in as a prop of the component
  const props = parts.props.filter((p) => !inScope.has(p.name));
  if (comp && props.length) {
    const p0 = comp.parameters[0];
    if (!p0) {
      const open = text.indexOf("(", comp.getStart(sf));
      if (open >= 0 && open < (comp.body?.getStart(sf) ?? Infinity))
        extra.push({ start: open + 1, end: open + 1, text: `{ ${props.map((p) => p.name).join(", ")} }: { ${props.map((p) => `${p.name}: ${p.type}`).join("; ")} }` });
    } else if (ts.isObjectBindingPattern(p0.name)) {
      const close = p0.name.end - 1;
      const has = p0.name.elements.length > 0;
      const trailing = has && /,\s*$/.test(text.slice(p0.name.elements[p0.name.elements.length - 1].end, close));
      extra.push({ start: close, end: close, text: (has && !trailing ? ", " : has ? " " : " ") + props.map((p) => p.name).join(", ") + " " });
      // and to its type: written inline, or a type alias or interface in this file
      let lit: ts.TypeLiteralNode | ts.InterfaceDeclaration | undefined;
      if (p0.type && ts.isTypeLiteralNode(p0.type)) lit = p0.type;
      else if (p0.type && ts.isTypeReferenceNode(p0.type) && ts.isIdentifier(p0.type.typeName)) {
        const tn = p0.type.typeName.text;
        for (const st of sf.statements) {
          if (ts.isTypeAliasDeclaration(st) && st.name.text === tn && ts.isTypeLiteralNode(st.type)) lit = st.type;
          if (ts.isInterfaceDeclaration(st) && st.name.text === tn) lit = st;
        }
      }
      if (lit) {
        const tclose = lit.end - 1;
        const ms = lit.members;
        const last = ms[ms.length - 1];
        const lpad = last ? indentOf(text, last.getStart(sf)) : "";
        const multiline = last && text.slice(lit.getStart(sf), tclose).includes("\n");
        const sep = last && !/[;,]\s*$/.test(text.slice(last.getStart(sf), last.end)) ? ";" : "";
        const add = multiline
          ? sep + props.map((p) => `\n${lpad}${p.name}: ${p.type}`).join("")
          : (last ? sep + " " : " ") + props.map((p) => `${p.name}: ${p.type}`).join("; ") + " ";
        const at = multiline ? last.end : tclose;
        extra.push({ start: at, end: at, text: add });
      }
    }
    // (props written as one identifier, (props: Props): left to the person, the names show in the code)
  }

  addImports(parts.imports, inScope);
  return { main, extra };

  /** Adds the imports the file lacks: into an existing import of the same module where there is one. */
  function addImports(need: Record<string, string>, have: Set<string>): void {
    const byModule = new Map<string, { named: string[]; dflt?: string }>();
    for (const [name, spec] of Object.entries(need)) {
      if (have.has(name)) continue;
      const m = moduleFor(spec, fileRel);
      const e = byModule.get(m.module) ?? { named: [] };
      if (m.kind === "default") e.dflt = name;
      else e.named.push(m.exported ? `${m.exported} as ${name}` : name);
      byModule.set(m.module, e);
    }
    const imports = sf.statements.filter(ts.isImportDeclaration);
    // written the way this file writes its imports: quotes and semicolons
    const sample = imports[0]?.getText(sf) ?? "";
    const q = /from\s+'/.test(sample) ? "'" : '"';
    const semi = sample && !sample.trimEnd().endsWith(";") ? "" : ";";
    const fresh: string[] = [];
    for (const [module, e] of byModule) {
      const existing = imports.find((i) => ts.isStringLiteral(i.moduleSpecifier) && i.moduleSpecifier.text === module && !i.importClause?.isTypeOnly);
      const nb = existing?.importClause?.namedBindings;
      if (existing && e.named.length && nb && ts.isNamedImports(nb)) {
        const last = nb.elements[nb.elements.length - 1];
        const at = last ? last.end : nb.end - 1;
        extra.push({ start: at, end: at, text: (last ? ", " : " ") + e.named.join(", ") + (last ? "" : " ") });
        e.named = [];
      }
      if (existing && e.dflt && !existing.importClause?.name) {
        // import { A } from "m" → import D, { A } from "m"
        const at = existing.importClause!.getStart(sf);
        extra.push({ start: at, end: at, text: `${e.dflt}, ` });
        e.dflt = undefined;
      }
      if (e.dflt) fresh.push(`import ${e.dflt} from ${q}${module}${q}${semi}`);
      if (e.named.length) fresh.push(`import { ${e.named.join(", ")} } from ${q}${module}${q}${semi}`);
    }
    if (!fresh.length) return;
    const last = imports[imports.length - 1];
    const at = last ? last.end : 0;
    // first in the list: at the same spot as another insertion, imports come before it
    extra.unshift({ start: at, end: at, text: last ? "\n" + fresh.join("\n") : fresh.join("\n") + "\n\n" });
  }
}

/** Applies edits that do not overlap, as an editor does: insertions at one spot land in list order. */
export function apply(text: string, all: Edit[]): string {
  const sorted = all.map((e, i) => ({ e, i })).sort((a, b) => b.e.start - a.e.start || b.i - a.i).map((x) => x.e);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
