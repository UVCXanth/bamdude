import type { HTMLAttributes, ReactNode } from 'react';
import { Card } from '../Card';

// A panel is not a link: no onClick / onContextMenu (Card's own click contract).
interface WorkshopPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onClick' | 'onContextMenu'> {
  /** The heading, 12 × 16 over a bottom border. Absent → no heading row. */
  title?: ReactNode;
  /** Beside the heading, on its right (a button, a count). */
  actions?: ReactNode;
  /** Under the body, inside the frame — a page bar, a summary. */
  footer?: ReactNode;
  /** No body padding — for a table, whose rows run to the frame's edges. */
  flush?: boolean;
  children: ReactNode;
}

/**
 * A Workshop panel (WS-13 E2 E01): the app's `Card` — secondary surface, 1 px
 * tertiary border, 12 px radius, the card shadow — with a heading row, a body
 * (16 px, or flush) and a footer. A composition and nothing more: it fetches
 * nothing, sizes nothing and knows no schema.
 */
export function WorkshopPanel({ title, actions, footer, flush = false, children, className = '', ...rest }: WorkshopPanelProps) {
  return (
    <Card className={`overflow-hidden ${className}`} {...rest}>
      {(title !== undefined || actions !== undefined) && (
        <div className="flex items-center justify-between gap-3 border-b border-bambu-dark-tertiary px-4 py-3">
          {title !== undefined && <h2 className="min-w-0 text-base font-semibold text-white">{title}</h2>}
          {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {flush ? children : <div className="p-4">{children}</div>}
      {footer}
    </Card>
  );
}

/**
 * The horizontal scroll of a table (WS-13 E2 E02): the table's own, never the
 * page's (`min-width: 0`, `max-width: 100%`), a named region the keyboard can
 * enter and scroll. A row's menu is portalled out of it, so nothing here needs
 * `overflow: visible`; the page bar goes in the panel's footer, outside it.
 */
export function WorkshopTableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="min-w-0 max-w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green"
    >
      {children}
    </div>
  );
}
