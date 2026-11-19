// Renders an expansion with the project's own components (its components/ui,
// Radix, react-hook-form, Tailwind 4), in a shadow root. Components from outside
// the library (layouts, app components) show as labelled outlines around their children.
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm, Controller } from "react-hook-form";
import type { PreviewNode } from "../../src/engine.js";
import css from "./preview.built.css";
import { MODULES } from "./modules";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";

type Model = { comps: Record<string, { module: string | null; as?: string }> };
let model: Model = { comps: {} };
export function useModel(m: Model): void {
  model = m;
}

/** The component a name refers to, from the module the code imports it from. */
function lookup(name: string): React.ElementType | null {
  const mod = model.comps[name]?.module;
  const m = mod ? MODULES[mod] : undefined;
  // imported renamed (import { Root as Radio }) or as a default: look it up by the name the module uses
  const as = model.comps[name]?.as;
  const c = m?.[as ?? name];
  return (typeof c === "function" || (typeof c === "object" && c !== null)) ? (c as React.ElementType) : null;
}

const OPEN_ROOTS = new Set(["Dialog", "Sheet", "AlertDialog", "Drawer"]);
const CONTENTS = new Set(["DialogContent", "SheetContent", "AlertDialogContent"]);

const FieldContext = React.createContext<Record<string, unknown> | null>(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FormContext = React.createContext<any>(null);

function propsOf(n: PreviewNode, field: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.props)) {
    if (k === "...field") { if (field) Object.assign(out, field); continue; }
    if (k.startsWith("...") || v.startsWith("{")) {
      // numbers and booleans written as expressions are safe to use
      const lit = /^\{(-?\d+(\.\d+)?|true|false)\}$/.exec(v);
      if (lit) out[k] = JSON.parse(lit[1] as string);
      continue;
    }
    if (k === "key" || /^on[A-Z]/.test(k)) continue;
    out[k] = v === "true" ? true : v;
  }
  return out;
}

function Outline({ name, children }: { name: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-muted-foreground/40 p-2">
      <div className="mb-1 font-mono text-[11px] text-muted-foreground">{`<${name}>`}</div>
      {children}
    </div>
  );
}

function El({ n, i }: { n: PreviewNode; i: number }): React.ReactNode {
  const field = React.useContext(FieldContext);
  const form = React.useContext(FormContext);
  const kids = n.kids.map((k, j) => <El key={j} n={k} i={j} />);
  const props = propsOf(n, field);
  if (n.name === "Form") return <PreviewForm>{kids}</PreviewForm>;
  if (n.name === "FormField") {
    const C = lookup("FormField") as React.ElementType;
    const name = typeof props.name === "string" ? props.name : `field${i}`;
    return (
      <C
        control={form?.control}
        name={name}
        render={({ field: f }: { field: Record<string, unknown> }) => (
          <FieldContext.Provider value={{ ...f, value: f.value ?? "" }}>{kids.length === 1 ? kids[0] : <>{kids}</>}</FieldContext.Provider>
        )}
      />
    );
  }
  if (OPEN_ROOTS.has(n.name)) { props.open = true; props.modal = false; }
  if (CONTENTS.has(n.name)) props.onOpenAutoFocus = (e: Event) => e.preventDefault();
  if (n.name === "Input" || n.name === "Textarea") props.readOnly = true;
  if (n.name === "Tabs" && !props.defaultValue) {
    const first = n.kids.find((k) => k.name === "TabsList")?.kids[0]?.props.value;
    if (first) props.defaultValue = first;
  }
  const C = lookup(n.name);
  const text = n.name === "AvatarFallback" && (!n.text || n.text === "Fallback") ? "AB" : n.text;
  const body = text || (kids.length === 1 ? kids[0] : kids.length ? kids : undefined);
  // plain markup (div, p, span) is drawn as itself, with its literal attributes
  if (/^[a-z]/.test(n.name)) {
    const attrs = Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v === "boolean" || (typeof v === "string" && !v.startsWith("{"))));
    if ("class" in attrs) delete attrs.class;
    if (/^(img|input|br|hr)$/.test(n.name)) return React.createElement(n.name, attrs);
    return React.createElement(n.name, attrs, body);
  }
  // asChild needs exactly one element to pass its behaviour to
  if (props.asChild && !(kids.length === 1 && !text)) delete props.asChild;
  if (!C) return <Outline name={n.name}>{body}</Outline>;
  return body === undefined ? <C {...props} /> : <C {...props}>{body}</C>;
}

function PreviewForm({ children }: { children: React.ReactNode }) {
  const form = useForm({ defaultValues: {} });
  const F = lookup("Form") as React.ElementType;
  return (
    <FormContext.Provider value={form}>
      <F {...form}>
        <form className="space-y-6" onSubmit={(e) => e.preventDefault()}>
          {children}
        </form>
      </F>
    </FormContext.Provider>
  );
}
void Controller;

class Boundary extends React.Component<{ children: React.ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
  render() {
    return this.state.err ? <div className="text-sm text-destructive">This one could not be drawn: {this.state.err}</div> : this.props.children;
  }
}

const roots = new Map<HTMLElement, Root>();
let propsInstalled = false;

/** Tailwind 4 registers its variables with @property, which only works in the document: copy those rules there once. */
function installProperties(): void {
  if (propsInstalled) return;
  propsInstalled = true;
  const rules = css.match(/@property[^{]+\{[^}]*\}/g) ?? [];
  const style = document.createElement("style");
  style.textContent = rules.join("\n");
  document.head.appendChild(style);
}

export function sweep(): void {
  for (const [host, root] of roots)
    if (!host.isConnected) {
      root.unmount();
      roots.delete(host);
    }
}

const has = (nodes: PreviewNode[], p: (n: PreviewNode) => boolean): boolean => nodes.some((n) => p(n) || has(n.kids, p));

export function renderReal(host: HTMLElement, nodes: PreviewNode[]): void {
  installProperties();
  let root = roots.get(host);
  if (!root) {
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    // the theme's variables are declared on :root, which a shadow root does not have
    style.textContent = css.replace(/:root\b/g, ":root,:host") + PREVIEW_CSS;
    const mount = document.createElement("div");
    mount.className = "pv-root";
    shadow.append(style, mount);
    root = createRoot(mount);
    roots.set(host, root);
  }
  const overlay = has(nodes, (n) => OPEN_ROOTS.has(n.name));
  const sidebar = has(nodes, (n) => n.name.startsWith("Sidebar"));
  const content = (
    <div className="flex flex-wrap items-start gap-4">
      {nodes.map((n, i) => (
        <div key={i} className="w-full">
          <El n={n} i={i} />
        </div>
      ))}
    </div>
  );
  root.render(
    <Boundary key={Math.random()}>
      <TooltipProvider>
        <div className={overlay ? "pv-frame pv-tall" : "pv-frame"}>{sidebar ? <SidebarProvider className="min-h-0">{content}</SidebarProvider> : content}</div>
      </TooltipProvider>
    </Boundary>,
  );
}

// the frame: a transform makes fixed-position overlays and dialogs stay inside it
const PREVIEW_CSS = `
.pv-root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--foreground); }
.pv-frame { position: relative; transform: translateZ(0); overflow: auto; background: var(--background); border: 1px solid var(--border); border-radius: 10px; padding: 16px; max-height: 520px; }
.pv-tall { min-height: 420px; }
`;
