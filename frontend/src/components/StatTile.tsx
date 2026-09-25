import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The tile grid above a Workshop list (spec workshop-lists, rules 1, 16): a
 * summary of the farm, never of the list's filters. Four equal columns (three
 * on the customer page); two on a narrow screen.
 */
export function StatTiles({ columns = 4, children }: { columns?: 3 | 4; children: ReactNode }) {
  return (
    <section className={`grid gap-3 grid-cols-2 ${columns === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-4'} mb-4`}>
      {children}
    </section>
  );
}

interface StatTileProps {
  label: string;
  /** The server's number (money formatted by the caller). `undefined` = not here yet. */
  value?: ReactNode;
  /** A second server number, drawn smaller after a slash — «printing / queued». */
  suffix?: ReactNode;
  sub?: ReactNode;
  /** `warn` — the theme's warning token (`text-status-warning`), readable in both themes. */
  tone?: 'warn';
  /** The request failed and there is nothing to show: a dash, never «…» forever. */
  failed?: boolean;
  /** What the tile draws instead of a number — a bar. */
  children?: ReactNode;
  testId?: string;
}

/** One figure as the server counted it — a tile adds nothing up. */
export function StatTile({ label, value, suffix, sub, tone, failed, children, testId }: StatTileProps) {
  const { t } = useTranslation();
  const pending = value === undefined && children == null;
  return (
    <div
      data-testid={testId}
      className="min-w-0 rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary p-3 space-y-1"
    >
      <p className="text-xs text-bambu-gray">{label}</p>
      {pending ? (
        <p className="text-2xl font-semibold text-bambu-gray" title={failed ? t('list.tiles.failed') : undefined}>
          {failed ? '—' : '…'}
        </p>
      ) : value !== undefined ? (
        <p className={`text-2xl font-semibold tabular-nums ${tone === 'warn' ? 'text-status-warning' : 'text-white'}`}>
          {value}
          {suffix != null && <span className="text-base font-normal text-bambu-gray"> / {suffix}</span>}
        </p>
      ) : null}
      {children}
      {sub != null && <p className="text-xs text-bambu-gray">{sub}</p>}
    </div>
  );
}
