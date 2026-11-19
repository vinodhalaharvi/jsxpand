// Stands in for @radix-ui/react-portal in the preview: dialogs, sheets and menus
// draw where they are instead of at the end of <body>, so they stay inside the
// preview box (and its styles) rather than covering the page.
import * as React from "react";

type Props = React.ComponentPropsWithoutRef<"div"> & { container?: Element | null; asChild?: boolean };

export const Portal = React.forwardRef<HTMLDivElement, Props>(function Portal({ container: _c, asChild: _a, children, ...props }, ref) {
  return (
    <div ref={ref} {...props}>
      {children}
    </div>
  );
});
export const Root = Portal;
