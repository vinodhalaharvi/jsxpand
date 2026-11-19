import { Expander, type Model, type PreviewNode } from "../src/engine.js";
import modelJson from "../src/model.json";
import corpus from "../src/corpus.json";

const model = modelJson as unknown as Model;
const x = new Expander(model);
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A light highlighter: tags, props, strings and keywords, in one pass so no rule sees another's markup. */
function hl(code: string): string {
  return esc(code).replace(
    /(&lt;\/?)([A-Za-z][A-Za-z0-9]*)|(\s)([a-zA-Z]+)(=)|("[^"]*")|\b(import|from|export|function|return)\b/g,
    (m, lt, tag, sp, attr, eq, str, kw) =>
      tag ? `${lt}<span class="tag">${tag}</span>` :
      attr ? `${sp}<span class="attr">${attr}</span>${eq}` :
      str ? `<span class="str">${str}</span>` :
      kw ? `<span class="kw">${kw}</span>` : m,
  );
}

// ---------- A small look-alike preview of the components ----------

const el = (tag: string, cls = "", text = ""): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** Draws one expansion with plain HTML styled after the usual look of these components. */
function preview(nodes: PreviewNode[]): HTMLElement {
  const box = el("div", "pv");
  const draw = (n: PreviewNode, into: HTMLElement, i: number): void => {
    const p = n.props;
    const kids = (e: HTMLElement) => n.kids.forEach((k, j) => draw(k, e, j));
    const variant = (base: string) => `${base} ${base}-${p.variant ?? "default"}${p.size === "sm" ? " pv-sm" : ""}`;
    let e: HTMLElement;
    switch (n.name) {
      case "Card": e = el("div", "pv-card"); break;
      case "CardHeader": case "DialogHeader": e = el("div", "pv-head"); break;
      case "CardTitle": case "DialogTitle": e = el("div", "pv-title", n.text || "Title"); break;
      case "CardDescription": case "DialogDescription": case "FormDescription": e = el("div", "pv-desc", n.text || "Description"); break;
      case "CardContent": e = el("div", "pv-content"); break;
      case "CardFooter": case "DialogFooter": e = el("div", "pv-foot"); break;
      case "Button": e = el("span", variant("pv-btn"), n.text || "Button"); break;
      case "Badge": e = el("span", variant("pv-badge"), n.text || "Badge"); break;
      case "Label": case "FormLabel": e = el("div", "pv-label", n.text || "Label"); break;
      case "Input": {
        e = el("div", "pv-input");
        const t = p.type === "password" ? "••••••••" : p.type === "file" ? "Choose file   No file chosen" : (p.placeholder ?? p.defaultValue ?? "");
        e.textContent = t;
        if (!p.defaultValue && p.type !== "password") e.classList.add("pv-ph");
        break;
      }
      case "Textarea": e = el("div", "pv-input pv-area pv-ph", p.placeholder ?? ""); break;
      case "Switch": e = el("span", "pv-switch"); break;
      case "Avatar": e = el("span", "pv-avatar"); { const f = n.kids.find((k) => k.name === "AvatarFallback"); e.textContent = (f?.text && f.text !== "Fallback" ? f.text : "AB").slice(0, 2); } into.appendChild(e); return;
      case "Dialog": e = el("div", "pv-dialog"); break;
      case "DialogTrigger": e = el("div", "pv-trigger"); break;
      case "DialogContent": e = el("div", "pv-modal"); e.appendChild(el("span", "pv-x", "×")); break;
      case "Form": case "FormField": case "FormControl": e = el("div", "pv-stack"); break;
      case "FormItem": e = el("div", "pv-item"); break;
      case "FormMessage": return;
      case "Table": {
        e = el("table", "pv-table");
        const cap = n.kids.find((k) => k.name === "TableCaption");
        n.kids.filter((k) => k !== cap).forEach((k, j) => draw(k, e, j));
        if (cap) e.appendChild(el("caption", "", cap.text || "Caption"));
        into.appendChild(e);
        return;
      }
      case "TableHeader": e = el("thead"); break;
      case "TableBody": e = el("tbody"); break;
      case "TableRow": e = el("tr"); break;
      case "TableHead": e = el("th", "", n.text || "Head"); break;
      case "TableCell": e = el("td", "", n.text || "—"); break;
      case "Tabs": e = el("div", "pv-tabs"); break;
      case "TabsList": e = el("div", "pv-tablist"); break;
      case "TabsTrigger": e = el("span", "pv-tab" + (i === 0 ? " on" : ""), n.text || p.value || "Tab"); break;
      case "TabsContent": if (n.kids.length === 0 || i > 1) { if (i > 1) return; } e = el("div", "pv-tabbody"); if (i > 1) return; break;
      case "Select": e = el("div", "pv-stack"); break;
      case "SelectTrigger": e = el("div", "pv-input pv-select"); break;
      case "SelectValue": e = el("span", "pv-ph", p.placeholder ?? "Select"); break;
      case "SelectContent": e = el("div", "pv-menu"); break;
      case "SelectItem": e = el("div", "pv-opt", n.text || p.value || "Item"); break;
      default: e = el("div", "pv-generic", n.name + (n.text ? `: ${n.text}` : ""));
    }
    kids(e);
    into.appendChild(e);
  };
  nodes.forEach((n, i) => draw(n, box, i));
  return box;
}

/** Ways to cut n letters into pieces of 2 to 14 letters: the tiling count, before any piece has to mean anything. */
function cuts(n: number): number {
  const f = [1];
  for (let i = 1; i <= n; i++) {
    let s = 0;
    for (let l = 2; l <= 14; l++) if (i - l >= 0) s += f[i - l] as number;
    f.push(s);
  }
  return f[n] as number;
}

const input = $<HTMLInputElement>("#q");
function run(): void {
  const q = input.value;
  const t0 = performance.now();
  const e = x.expand(q, 3);
  const ms = performance.now() - t0;
  const letters = e.text.replace(/[^a-z0-9]/g, "").length;
  $("#stats").innerHTML = e.text
    ? e.results.length
      ? `<b>${e.readings.toLocaleString()}</b> ways to read it · best takes <b>${Math.round((e.results[0]?.prob ?? 0) * 100)}%</b> · ${e.states.toLocaleString()} subproblems · ${ms < 1 ? "<1" : Math.round(ms)} ms`
      : "No reading of that matches components in this codebase."
    : "";
  $("#gf").innerHTML = letters
    ? `Cut into pieces of 2 to 14 letters, <b>${letters}</b> letters can be split <b>${cuts(letters).toLocaleString()}</b> ways: the coefficient of z<sup>${letters}</sup> in 1 / (1 − z² − z³ − … − z¹⁴). Each piece can then name several components, sit at several depths, and bring in a wrapper, which is how they become <b>${e.readings.toLocaleString()}</b> readings.`
    : "Type something to see the counts for it.";
  const out = $("#results");
  out.innerHTML = "";
  e.results.forEach((r, i) => {
    const card = document.createElement("section");
    card.className = "result" + (i === 0 ? " best" : "");
    const full = (r.imports.length ? r.imports.join("\n") + "\n\n" : "") + r.code;
    const why = x.why(r.steps).map((w) => `<li${w.startsWith("   ") ? ' class="sub"' : ""}>${esc(w.trim())}</li>`).join("");
    const filled = [...new Set(r.filled)].map((f) => `<li>${esc(f)}</li>`).join("");
    card.innerHTML = `
      <div class="head">
        <span class="rank">${i === 0 ? "Best" : "Option " + (i + 1)}</span>
        <span class="bar"><span style="width:${Math.max(1, r.prob * 100)}%"></span></span>
        <span class="pct">${(r.prob * 100).toFixed(1)}%</span>
        <button class="copy">Copy</button>
      </div>
      <div class="pvslot"></div>
      <pre><code>${hl(full)}</code></pre>
      <details${i === 0 ? " open" : ""}><summary>Why</summary><ul class="why">${why}</ul>${filled ? `<p class="fl">Filled in from your code:</p><ul class="why">${filled}</ul>` : ""}</details>`;
    (card.querySelector(".pvslot") as HTMLElement).appendChild(preview(r.preview));
    (card.querySelector(".copy") as HTMLButtonElement).onclick = (ev) => {
      navigator.clipboard?.writeText(full).catch(() => undefined);
      (ev.target as HTMLButtonElement).textContent = "Copied";
      setTimeout(() => ((ev.target as HTMLButtonElement).textContent = "Copy"), 1200);
    };
    out.appendChild(card);
  });
}
input.addEventListener("input", run);
document.querySelectorAll<HTMLButtonElement>(".ex").forEach((b) => (b.onclick = () => { input.value = b.dataset.q ?? b.textContent ?? ""; run(); input.focus(); }));

// the sample code it learned from
const list = $("#files");
for (const [name, src] of Object.entries(corpus as Record<string, string>)) {
  const d = document.createElement("details");
  d.innerHTML = `<summary>${esc(name)}</summary><pre><code>${hl(src)}</code></pre>`;
  list.appendChild(d);
}
$("#learned").textContent = `${model.files} files · ${Object.keys(model.comps).length} components · ${Object.values(model.edges).reduce((a, e) => a + Object.values(e).reduce((p, q) => p + q, 0), 0)} parent→child uses`;
input.value = "cardhdrbtn";
run();
