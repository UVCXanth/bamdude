import type { ReactNode } from 'react';

/**
 * The Workshop's form grid (WS-13 E2 D07): two equal columns (`minmax(0, 1fr)`,
 * so a long value never widens its column), 14 px between rows and 16 px between
 * columns, 8 px above and 12 px below; one column at a viewport of 760 px and
 * narrower. It lays out fields a form already has — it generates none, and rows
 * that are not a label over a control (contact rows, pickers) stay out of it.
 */
export function WorkshopFormGrid({ children }: { children: ReactNode }) {
  // ⚠️ `max-[761px]`, not `max-[760px]`: Tailwind 4 writes `max-*` as `width < N`,
  // and the rule is «760 and narrower» — at exactly 760 the grid is one column.
  return <div className="mt-2 mb-3 grid grid-cols-2 gap-x-4 gap-y-3.5 max-[761px]:grid-cols-1">{children}</div>;
}

/**
 * One field of the grid: the label (secondary, 14 px) 4 px over its control, an
 * optional hint (12 px) under it. The hint's id is `${htmlFor}-hint`; the control
 * points `aria-describedby` at it. `full` spans both columns.
 */
export function WorkshopField({
  label,
  htmlFor,
  hint,
  full = false,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${full ? 'col-span-full' : ''}`}>
      <label htmlFor={htmlFor} className="text-sm text-bambu-gray-light">
        {label}
      </label>
      {children}
      {hint !== undefined && (
        <p id={`${htmlFor}-hint`} className="text-xs leading-[18px] text-bambu-gray">
          {hint}
        </p>
      )}
    </div>
  );
}
