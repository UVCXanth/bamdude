import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { FarmNeeds } from '../../api/client';
import { hexForColorName } from '../../utils/colors';
import { formatWeight } from '../../utils/weight';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { ForecastHint } from './ForecastHint';
import { needTestId } from './filamentNeedsHelpers';

/** The chips shown before «N more» (the mockup's seven). */
const FIRST_CHIPS = 7;

type Row = FarmNeeds['rows'][number];

/**
 * Everything is KNOWN and nothing is short (WS-13 E7 C03, R02) — the only state
 * that may say «everything is on the shelf». A shelf that could not be read, a
 * shelf amount missing on any row, or a print without grams (on a row or on no
 * row at all) leaves the need partly unknown, and a green line would hide that.
 */
export function everythingOnTheShelf(farm: FarmNeeds): boolean {
  return (
    !farm.stock_unavailable &&
    farm.unknown_prints === 0 &&
    farm.rows.every((row) => row.unknown_prints === 0 && row.have_g != null) &&
    !farm.rows.some((row) => row.short_g != null && row.short_g > 0)
  );
}

/**
 * The farm's filament panel over the orders (WS-13 E7 C03, O03): every active
 * order's slicer estimate against the shelf, from `GET /projects/filament` — not
 * the visible tab or filter. A panel of its own; absent only when no active order
 * needs any filament, there while it is read and when the read failed.
 */
export function FilamentStrip() {
  const { t } = useTranslation();
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const { data: farm, isError, refetch } = useQuery({
    queryKey: ['orders-filament'],
    queryFn: () => api.getOrdersFilament(),
    staleTime: 30_000,
  });

  if (farm && farm.rows.length === 0 && farm.unknown_prints === 0) return null;

  const title = (
    <h2 id={headingId} className="basis-full text-xs text-bambu-gray">
      {t('orders.filament.stripTitle')} {farm && <ForecastHint forecast={farm} />}
    </h2>
  );
  const panel = 'mb-4 flex flex-wrap items-center gap-1.5 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3';

  if (!farm) {
    return (
      <section data-testid="filament-strip" aria-labelledby={headingId} aria-busy={!isError} className={panel}>
        {title}
        {isError ? (
          <LoadFailedNote role="status" message={t('orders.filament.stripFailed')} onRetry={() => void refetch()} />
        ) : (
          <span className="text-xs text-bambu-gray">
            …<span className="sr-only">{t('common.loading')}</span>
          </span>
        )}
      </section>
    );
  }

  const rows = open ? farm.rows : farm.rows.slice(0, FIRST_CHIPS);
  const hidden = farm.rows.length - FIRST_CHIPS;
  return (
    <section data-testid="filament-strip" aria-labelledby={headingId} className={panel}>
      {title}
      {everythingOnTheShelf(farm) && <span className="text-xs text-bambu-green">{t('orders.filament.everythingOnShelf')}</span>}
      {farm.stock_unavailable && (
        <span className="basis-full text-xs text-amber-400">{t('orders.filament.shelfUnknown')}</span>
      )}
      {rows.map((row) => (
        <FilamentChip key={needTestId(row.material, row.colour, 'filament-chip-')} row={row} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="rounded-full px-2.5 py-1 text-xs text-bambu-green hover:underline"
        >
          {open ? t('orders.filament.showLess') : t('orders.filament.moreChips', { count: hidden })}
        </button>
      )}
      {farm.unknown_prints > 0 && (
        <span className="text-xs text-bambu-gray">{t('orders.filament.printsWithoutEstimate', { count: farm.unknown_prints })}</span>
      )}
    </section>
  );
}

function FilamentChip({ row }: { row: Row }) {
  const { t } = useTranslation();
  const short = row.short_g != null && row.short_g > 0;
  const swatch = row.colour ? hexForColorName(row.colour) : null;
  // A need with no grams at all is unknown, not zero; with SOME grams missing it is a lower bound.
  const need =
    row.unknown_prints > 0 && row.need_g === 0
      ? '—'
      : row.unknown_prints > 0
        ? `≥ ${formatWeight(row.need_g)}`
        : formatWeight(row.need_g);
  const have = row.have_g == null ? '—' : formatWeight(row.have_g);
  const name = row.colour ? `${row.material} ${row.colour.toLowerCase()}` : row.material;
  const tooltip = [
    t('orders.filament.ordersCount', { count: row.orders_count }),
    row.have_type_g != null ? t('orders.filament.typeOnShelf', { material: row.material, amount: formatWeight(row.have_type_g) }) : null,
    row.unknown_prints > 0 ? t('orders.filament.unknownPrints', { count: row.unknown_prints }) : null,
  ]
    .filter(Boolean)
    .join('; ');
  return (
    <span
      data-testid={needTestId(row.material, row.colour, 'filament-chip-')}
      data-short={String(short)}
      title={tooltip}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs tabular-nums ${
        short ? 'border-amber-400/45 bg-amber-400/10 text-amber-300' : 'border-bambu-dark-tertiary bg-bambu-dark text-bambu-gray-light'
      }`}
    >
      {swatch && (
        <span data-swatch aria-hidden="true" className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: swatch }} />
      )}
      {`${name} · ${t('orders.filament.needHave', { need, have })}`}
      {short && ` · ${t('orders.filament.shortBy', { amount: formatWeight(row.short_g ?? 0) })}`}
    </span>
  );
}
