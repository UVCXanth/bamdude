import type { ReactNode, Ref } from 'react';

/**
 * The title row of every Workshop list page (spec workshop-lists, rule 24): the
 * title, one line of what the page is for, and the page's actions on the right —
 * the view switch first, then the create buttons (decision 13).
 */
export function ListPageHeader({
  title,
  subtitle,
  icon,
  children,
  headingRef,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  children?: ReactNode;
  /** Where focus lands when a dialog's opener has gone (WS-13 E6 B07) — the heading becomes focusable. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div data-testid="list-page-header" className="flex items-start justify-between mb-4 flex-wrap gap-3">
      <div className="min-w-0">
        <h1
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
          className="text-2xl font-semibold text-white flex items-center gap-2 outline-none"
        >
          {icon}
          {title}
        </h1>
        {subtitle && <p className="text-sm text-bambu-gray mt-1">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}
