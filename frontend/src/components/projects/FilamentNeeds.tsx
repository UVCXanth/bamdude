import { useTranslation } from 'react-i18next';
import type { NeedRow, OrderNeeds } from '../../api/client';
import { formatWeight } from '../../utils/weight';
import { getColorName, getSwatchStyle } from '../../utils/colors';
import { ForecastHint } from './ForecastHint';
import { needTestId } from './filamentNeedsHelpers';

/** A line colour a swatch can be drawn for — a hex; a name is shown as text only. */
const HEX = /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i;

/**
 * The need per material and line colour against the shelf (spec 2026-09-07,
 * Slice C) — the ONE body of the order page's filament panel and of the plan
 * dialog's compact block (WS-13 E3 G03, R04).
 *
 * ⚠️ **It says only what it knows** (R02). A need is «at least» while some
 * prints have no weight, and «weight unknown» when none has; «enough» is said
 * only when the shelf AND the shortfall are known, nothing is short and no
 * print is without a weight — otherwise «enough for the known part», or no
 * verdict at all. A known zero is a zero (§13).
 */
export function FilamentNeedsRows({ needs }: { needs: OrderNeeds }) {
  const { t } = useTranslation();
  return (
    <div>
      <ul>
        {needs.rows.map((row) => (
          <NeedRowItem key={needTestId(row.material, row.colour)} row={row} />
        ))}
      </ul>
      {needs.unknown_prints > 0 && (
        <p className="mt-2 text-xs text-amber-400">{t('orders.filament.unattributedPrints', { count: needs.unknown_prints })}</p>
      )}
      {needs.stock_unavailable && <p className="mt-2 text-xs text-amber-400">{t('orders.filament.stockUnavailable')}</p>}
    </div>
  );
}

function NeedRowItem({ row }: { row: NeedRow }) {
  const { t } = useTranslation();
  // A shortfall is a verdict about the shelf: none without one (R02, review 12).
  const short = row.have_g != null && row.short_g != null && row.short_g > 0;
  const shelfKnown = row.have_g != null && row.short_g != null;
  const partial = row.unknown_prints > 0;
  const colourIsHex = row.colour != null && HEX.test(row.colour);
  const colourName = row.colour ? (colourIsHex ? getColorName(row.colour, row.material) : row.colour) : null;

  const need =
    partial && row.need_g === 0
      ? t('orders.filament.weightUnknown')
      : partial
        ? t('orders.filament.atLeast', { amount: formatWeight(row.need_g) })
        : formatWeight(row.need_g);

  return (
    <li
      data-testid={needTestId(row.material, row.colour)}
      data-short={String(short)}
      className={`flex flex-wrap items-baseline gap-x-3.5 gap-y-1 border-b border-bambu-dark-tertiary py-2 text-[13px] last:border-b-0 ${
        short ? 'text-amber-400' : 'text-bambu-gray-light'
      }`}
    >
      <span className="flex w-full items-center gap-1.5 font-medium text-white">
        {colourIsHex && <span data-swatch className="h-2.5 w-2.5 shrink-0 rounded-full" style={getSwatchStyle(row.colour)} />}
        {colourName ? `${row.material} ${colourName}` : row.material}
      </span>
      <span>
        {t('orders.filament.need')} <b className="font-semibold tabular-nums">{need}</b>
      </span>
      <span>
        {t('orders.filament.shelf')}{' '}
        {row.have_g == null ? (
          <span title={t('orders.filament.stockUnavailable')}>—</span>
        ) : (
          <span className="tabular-nums">
            {formatWeight(row.have_g)}
            {row.colour && row.have_type_g != null && row.have_type_g !== row.have_g && (
              <span className="text-bambu-gray"> ({t('orders.filament.ofType', { amount: formatWeight(row.have_type_g), material: row.material })})</span>
            )}
          </span>
        )}
      </span>
      {short && (
        <span className="text-amber-400">
          {t(partial ? 'orders.filament.shortAtLeast' : 'orders.filament.short', { amount: formatWeight(row.short_g as number) })}
        </span>
      )}
      {!short && shelfKnown && !partial && <span className="text-bambu-green">{t('orders.filament.enough')}</span>}
      {!short && shelfKnown && partial && <span className="text-bambu-gray">{t('orders.filament.enoughKnown')}</span>}
      {partial && <span className="text-amber-400">{t('orders.filament.unknownPrints', { count: row.unknown_prints })}</span>}
    </li>
  );
}

/**
 * The plan dialog's compact filament block (`PlanFromFilesModal`) — the same
 * body as the order page's side panel, in the box the dialog always had (R04).
 * Nothing to say is nothing drawn here; the panel says it in words.
 */
export function FilamentNeeds({ needs }: { needs: OrderNeeds }) {
  const { t } = useTranslation();
  if (needs.rows.length === 0 && needs.unknown_prints === 0) return null;
  return (
    <div className="rounded-xl border border-bambu-dark-tertiary bg-bambu-dark p-3 text-sm" data-testid="filament-needs">
      <p className="text-xs text-bambu-gray mb-2">
        {t('orders.filament.title')} <ForecastHint forecast={needs} />
      </p>
      <FilamentNeedsRows needs={needs} />
    </div>
  );
}
