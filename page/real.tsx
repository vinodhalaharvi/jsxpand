// Renders an expansion with the real components: React, Radix and Tailwind,
// inside a shadow root so their styles stay out of the page and the page's out of them.
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import type { PreviewNode } from "../src/engine.js";
import css from "./preview.built.css";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { Input, Textarea } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "./ui/form";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const COMPONENTS: Record<string, React.ComponentType<any>> = {
  Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Badge, Input, Textarea, Label, Switch,
  Avatar, AvatarFallback, AvatarImage, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, FormControl, FormDescription, FormItem, FormLabel, FormMessage,
};

/** The field a FormField hands its render prop, for the {...field} on an Input inside it. */
const FieldContext = React.createContext<Record<string, unknown> | null>(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FormContext = React.createContext<any>(null);

/** Props as the preview can use them: literal values as they are, expressions dropped (no data here). */
function propsOf(n: PreviewNode, field: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.props)) {
    if (k === "...field") { if (field) Object.assign(out, field); continue; }
    if (k.startsWith("...") || v.startsWith("{")) continue;
    if (k === "key" || k === "onSubmit" || k === "onClick") continue;
    out[k] = v === "true" ? true : v;
  }
  return out;
}

function El({ n, i }: { n: PreviewNode; i: number }): React.ReactNode {
  const field = React.useContext(FieldContext);
  const form = React.useContext(FormContext);
  const kids = n.kids.map((k, j) => <El key={j} n={k} i={j} />);
  const props = propsOf(n, field);
  if (n.name === "Form") return <PreviewForm>{kids}</PreviewForm>;
  if (n.name === "FormField") {
    const name = typeof props.name === "string" ? props.name : `field${i}`;
    return (
      <FormField
        control={form?.control}
        name={name}
        render={({ field: f }) => <FieldContext.Provider value={{ ...f, value: f.value ?? "" }}>{kids.length === 1 ? kids[0] : <>{kids}</>}</FieldContext.Provider>}
      />
    );
  }
  if (n.name === "Tabs" && !props.defaultValue) {
    const first = n.kids.find((k) => k.name === "TabsList")?.kids[0]?.props.value;
    if (first) props.defaultValue = first;
  }
  // inputs in a preview show what was asked for and stay put
  if (n.name === "Input" || n.name === "Textarea") props.readOnly = true;
  if (n.name === "Input" && props.defaultValue && field) delete props.defaultValue;
  const C = COMPONENTS[n.name];
  if (!C) return <div style={{ border: "1px dashed #a1a1aa", borderRadius: 6, padding: "4px 8px" }}>{n.name}</div>;
  // a placeholder like "Fallback" reads as initials in an avatar
  const text = n.name === "AvatarFallback" && (!n.text || n.text === "Fallback") ? "AB" : n.text;
  // one child goes in as itself, not a list: Slot-based parts (asChild, FormControl) need exactly one element
  const body = text || (kids.length === 1 ? kids[0] : kids.length ? kids : undefined);
  return body === undefined ? <C {...props} /> : <C {...props}>{body}</C>;
}

function PreviewForm({ children }: { children: React.ReactNode }) {
  const form = useForm({ defaultValues: {} });
  return (
    <FormContext.Provider value={form}>
      <Form {...form}>
        <form className="space-y-6" onSubmit={(e) => e.preventDefault()}>
          {children}
        </form>
      </Form>
    </FormContext.Provider>
  );
}

class Boundary extends React.Component<{ children: React.ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
  render() {
    return this.state.err ? <div className="pv-err">This one could not be drawn: {this.state.err}</div> : this.props.children;
  }
}

const roots = new Map<HTMLElement, Root>();

/** Unmounts the previews whose hosts have left the page. */
export function sweep(): void {
  for (const [host, root] of roots)
    if (!host.isConnected) {
      root.unmount();
      roots.delete(host);
    }
}

/** Draws the nodes into `host`, reusing its shadow root and React root across updates. */
export function renderReal(host: HTMLElement, nodes: PreviewNode[]): void {
  let root = roots.get(host);
  if (!root) {
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    const mount = document.createElement("div");
    mount.className = "pv-root";
    shadow.append(style, mount);
    root = createRoot(mount);
    roots.set(host, root);
  }
  root.render(
    <Boundary key={Math.random()}>
      <div className="flex flex-wrap items-start gap-4">
        {nodes.map((n, i) => (
          // each top-level piece gets the width it would have in a page column
          <div key={i} className="w-full max-w-md">
            <El n={n} i={i} />
          </div>
        ))}
      </div>
    </Boundary>,
  );
}
