import { renderReal, sweep, useModel } from "./render";

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


interface Out { prob: number; file: string; preview: never[]; why: string[]; filled: string[]; declared: string[] }
interface Msg { kind: "result"; id: number; ms: number; text: string; readings: number; states: number; results: Out[] }

const worker = new Worker("worker.js");
const input = $<HTMLInputElement>("#q");
let asked = 0;
let shown = 0;
let timer = 0;

worker.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.kind === "ready") {
    useModel({ comps: m.modules });
    $("#learned").innerHTML = `${m.stats.files} files · ${m.stats.components} components · ${m.stats.uses.toLocaleString()} parent→child uses`;
    send();
    return;
  }
  if (m.id < shown) return;
  shown = m.id;
  show(m as Msg);
};

function send(): void {
  worker.postMessage({ id: ++asked, q: input.value });
  $("#stats").classList.add("busy");
}

function show(e: Msg): void {
  if (e.id === asked) $("#stats").classList.remove("busy");
  const letters = e.text.replace(/[^a-z0-9]/g, "").length;
  $("#stats").innerHTML = e.text
    ? e.results.length
      ? `<b>${e.readings.toLocaleString()}</b> readings · best takes <b>${Math.round((e.results[0]?.prob ?? 0) * 100)}%</b> · ${e.states.toLocaleString()} subproblems · ${Math.round(e.ms)} ms`
      : "No reading of that matches components in this codebase."
    : "";
  $("#gf").innerHTML = letters
    ? `Cut into pieces of 2 to 14 letters, <b>${letters}</b> letters can be split <b>${cuts(letters).toLocaleString()}</b> ways: the coefficient of z<sup>${letters}</sup> in 1 / (1 − z² − z³ − … − z¹⁴). Each piece can then name several components, sit at several depths, and bring in a wrapper. Readings too unlikely to matter are not followed, which keeps the search to the plausible ones.`
    : "Type something to see the counts for it.";
  const out = $("#results");
  out.innerHTML = "";
  sweep();
  e.results.forEach((r, i) => {
    const card = document.createElement("section");
    card.className = "result" + (i === 0 ? " best" : "");
    const li = (xs: string[]) => xs.map((w) => `<li${w.startsWith("   ") ? ' class="sub"' : ""}>${esc(w.trim())}</li>`).join("");
    card.innerHTML = `
      <div class="head">
        <span class="rank">${i === 0 ? "Best" : "Option " + (i + 1)}</span>
        <span class="bar"><span style="width:${Math.max(1, r.prob * 100)}%"></span></span>
        <span class="pct">${(r.prob * 100).toFixed(1)}%</span>
        <button class="copy">Copy</button>
      </div>
      <div class="pvslot"></div>
      <details${i === 0 ? "" : ""}><summary>Code</summary><pre><code>${hl(r.file)}</code></pre></details>
      <details${i === 0 ? " open" : ""}><summary>Why</summary><ul class="why">${li(r.why)}</ul>${r.filled.length ? `<p class="fl">Filled in from the code:</p><ul class="why">${li(r.filled)}</ul>` : ""}${r.declared.length ? `<p class="fl">Declared, so the component compiles:</p><ul class="why">${li(r.declared)}</ul>` : ""}</details>`;
    renderReal(card.querySelector(".pvslot") as HTMLElement, r.preview);
    (card.querySelector(".copy") as HTMLButtonElement).onclick = (ev) => {
      navigator.clipboard?.writeText(r.file).catch(() => undefined);
      (ev.target as HTMLButtonElement).textContent = "Copied";
      setTimeout(() => ((ev.target as HTMLButtonElement).textContent = "Copy"), 1200);
    };
    out.appendChild(card);
  });
}

input.addEventListener("input", () => {
  clearTimeout(timer);
  timer = window.setTimeout(send, 90);
});
document.querySelectorAll<HTMLButtonElement>(".ex").forEach((b) => (b.onclick = () => { input.value = b.dataset.q ?? b.textContent ?? ""; send(); input.focus(); }));
input.value = "tabs>list>trig*3^cont";
