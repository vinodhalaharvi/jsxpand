import * as React from "react";

/** A panel: used by the app. */
export function Panel({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>;
}

/** A part of the panel, never used by the app. */
export function PanelBadge({ tone, children }: { tone: "info" | "warn"; children?: React.ReactNode }) {
  return <span data-tone={tone}>{children}</span>;
}

/** @internal how Panel is built, not for apps */
export function PanelSecret() {
  return <i />;
}

/** Capitalised, exported, not a component. */
export const PanelSizes = { small: 1, large: 2 };

/** A class component. */
export class PanelLegacy extends React.Component<{ title: string }> {
  render() {
    return <h2>{this.props.title}</h2>;
  }
}
