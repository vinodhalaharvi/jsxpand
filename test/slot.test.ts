import { describe, expect, it } from "vitest";
import { slot } from "../vscode/src/insert.js";

const at = (src: string) => {
  const o = src.indexOf("|");
  return slot(src.slice(0, o) + src.slice(o + 1), o);
};

describe("slot", () => {
  it("finds the components around a typed <", () => {
    expect(at(`const A = () => (\n  <Card>\n    <|\n  </Card>\n);`)).toMatchObject({ parent: "Card", grand: "ROOT", prev: null, inside: ["Card"] });
  });
  it("knows the component just before it, through lowercase elements", () => {
    const s = at(`const A = () => (\n  <Card>\n    <div>\n      <CardHeader />\n    </div>\n    <|\n  </Card>\n);`);
    expect(s).toMatchObject({ parent: "Card", prev: "CardHeader" });
  });
  it("knows the component two levels up", () => {
    const s = at(`const A = () => (\n  <Table>\n    <TableHeader>\n      <TableRow>\n        |\n      </TableRow>\n    </TableHeader>\n  </Table>\n);`);
    expect(s).toMatchObject({ parent: "TableRow", grand: "TableHeader", prev: null });
  });
  it("replaces the < it was typed after", () => {
    const src = `const A = () => (\n  <Card>\n    <|\n  </Card>\n);`;
    const s = at(src)!;
    expect(src.replace("|", "").slice(s.start, s.end)).toBe("<");
  });
  it("is nothing after an abbreviation, at the top of a return, or in an attribute", () => {
    expect(at(`const A = () => (\n  <Card>\n    cardhdr|\n  </Card>\n);`)).toBeNull();
    expect(at(`const A = () => (\n  <|\n);`)).toBeNull();
    expect(at(`const A = () => <Card className="<|" />;`)).toBeNull();
    expect(at(`const A = () => (\n  <div>\n    <|\n  </div>\n);`)).toBeNull();
  });
});
