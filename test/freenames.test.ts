// The names a piece of code reads from outside itself.
import { expect, it } from "vitest";
import ts from "typescript";
import { freeNames } from "../src/learn.mjs";

const free = (code: string) => freeNames(ts.createSourceFile("x.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).statements[0]!).sort();

it("does not count a callback's own locals", () => {
  expect(free("const t = make({ fn: (row, v) => { const id = row.get('id'); const s = String(v); return id.includes(s) } })")).toEqual(["make", "t"]);
});
it("binds for loops, catch clauses and inner functions", () => {
  expect(free("const f = () => { for (const x of xs) use(x); try { go() } catch (e) { log(e) } function h() { return y } return h }")).toEqual(["f", "go", "log", "use", "xs", "y"]);
});
it("still sees what comes from outside", () => {
  expect(free("const a = () => { const b = c + d.e; return b }")).toEqual(["a", "c", "d"]);
});
