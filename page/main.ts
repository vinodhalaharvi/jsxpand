import { Expander, type Model } from "../src/engine.js";
import { renderReal, sweep } from "./real";
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
  sweep();
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
    renderReal(card.querySelector(".pvslot") as HTMLElement, r.preview);
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
