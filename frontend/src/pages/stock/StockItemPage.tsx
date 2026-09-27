import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpFromLine, ChevronRight, ClipboardCheck, Loader2, Lock, LockOpen, MapPin, Wrench } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../../components/Button';
import { StatTile, StatTiles } from '../../components/StatTile';
import { lineConfigLabel } from '../../components/projects/lineConfigLabel';
import { StockDialogs } from '../../components/stock/StockDialogs';
import type { StockDialogState } from '../../components/stock/StockDialogs';
import { StockJournal } from '../../components/stock/StockJournal';
import { useStockItem } from '../../hooks/useFinishedStock';

const SECTION = 'rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4 space-y-2';

/**
 * One finished-goods position (spec workshop-finished-goods, rule 25): its
 * figures, whether it needs replenishing, who holds it, the product's other
 * configurations, the free parts under this one, and its own journal.
 *
 * Every figure is the server's detail — nothing here adds a column up.
 * Data before status, as on every detail page: a failed refetch keeps the
 * position on screen and the hook's `refreshToast` reports it once.
 */
export function StockItemPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const itemId = Number(id);
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('projects:update');
  const { data: item, isError, error, isLoading } = useStockItem(itemId);
  const [dialog, setDialog] = useState<StockDialogState>(null);

  if (!item) {
    if (isLoading) {
      return (
        <div className="p-4 flex items-center gap-2 text-bambu-gray">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('common.loading')}
        </div>
      );
    }
    return (
      <div className="p-4 text-sm text-red-500">
        {t('stock.item.loadFailed')} {isError ? (error as Error)?.message : ''}
      </div>
    );
  }

  const caption = lineConfigLabel(item.configuration, 'product', t);
  const facts = [item.product.sku, item.code, caption, item.location ?? t('stock.finished.noLocation')].filter(Boolean);

  return (
    <div className="p-4 space-y-4">
      <nav className="flex items-center gap-1 text-sm text-bambu-gray">
        <Link to="/stock" className="hover:text-white transition-colors">
          {t('projects.tabs.stock')}
        </Link>
        <ChevronRight className="w-4 h-4" />
        <span className="text-white">{item.product.name}</span>
      </nav>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold text-white">{item.product.name}</h1>
          <p className="text-sm text-bambu-gray">{facts.join(' · ')}</p>
          <Link to={`/products/${item.product.id}`} className="text-sm text-bambu-green hover:underline">
            {t('stock.item.openProduct')}
          </Link>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="secondary" onClick={() => setDialog({ kind: 'stocktake', item })}>
              <ClipboardCheck className="w-4 h-4" />
              {t('stock.finished.action.stocktake')}
            </Button>
            <Button variant="secondary" disabled={item.available <= 0} onClick={() => setDialog({ kind: 'reserve', item })}>
              <Lock className="w-4 h-4" />
              {t('stock.finished.action.reserve')}
            </Button>
            <Button variant="secondary" disabled={item.reserved <= 0} onClick={() => setDialog({ kind: 'release', item })}>
              <LockOpen className="w-4 h-4" />
              {t('stock.finished.action.release')}
            </Button>
            <Button variant="secondary" disabled={item.on_hand <= 0} onClick={() => setDialog({ kind: 'issue', item })}>
              <ArrowUpFromLine className="w-4 h-4" />
              {t('stock.finished.action.issue')}
            </Button>
            <Button variant="secondary" onClick={() => setDialog({ kind: 'params', item })}>
              <MapPin className="w-4 h-4" />
              {t('stock.finished.action.params')}
            </Button>
          </div>
        )}
      </header>

      <StatTiles>
        <StatTile testId="item-tile-on-hand" label={t('stock.finished.onHand')} value={item.on_hand} />
        <StatTile testId="item-tile-reserved" label={t('stock.finished.reserved')} value={item.reserved} />
        <StatTile
          testId="item-tile-available"
          label={t('stock.finished.available')}
          value={item.available}
          tone={item.below_min ? 'warn' : undefined}
        />
        <StatTile
          testId="item-tile-min"
          label={t('stock.finished.minimum')}
          value={item.min_qty > 0 ? item.min_qty : '—'}
        />
      </StatTiles>

      <div
        data-testid="item-strip"
        className={`rounded-xl border px-4 py-3 flex items-center justify-between gap-3 flex-wrap ${
          item.below_min ? 'border-status-warning/40 bg-status-warning/10' : 'border-bambu-dark-tertiary bg-bambu-dark-secondary'
        }`}
      >
        <p className={`text-sm ${item.below_min ? 'text-status-warning' : 'text-bambu-gray'}`}>
          {item.below_min
            ? t('stock.item.needsReplenishment', { n: item.min_qty - item.available })
            : item.min_qty > 0
              ? t('stock.item.withinNorm')
              : t('stock.item.noMinimum')}
        </p>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setDialog({ kind: 'receipt', item })}>
              <ArrowDownToLine className="w-4 h-4" />
              {t('stock.finished.action.receipt')}
            </Button>
            {item.can_assemble > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'assemble', item })}>
                <Wrench className="w-4 h-4" />
                {t('stock.finished.action.assemble')}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className={SECTION} data-testid="item-reservations">
          <h2 className="text-sm font-medium text-white">{t('stock.item.reservations')}</h2>
          {item.reservations.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('stock.item.noReservations')}</p>
          ) : (
            <ul className="text-sm text-white space-y-1">
              {item.reservations.map((r) => (
                <li key={r.project_line_id ?? 'none'}>
                  {r.project_id != null ? (
                    <>
                      <Link to={`/projects/${r.project_id}`} className="text-bambu-green hover:underline">
                        {r.project_code}
                      </Link>
                      <span className="tabular-nums"> — {r.qty}</span>
                    </>
                  ) : (
                    t('stock.item.withoutOrder', { n: r.qty })
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={SECTION} data-testid="item-siblings">
          <h2 className="text-sm font-medium text-white">{t('stock.item.siblings')}</h2>
          {item.siblings.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('stock.item.noSiblings')}</p>
          ) : (
            <ul className="text-sm space-y-2">
              {item.siblings.map((s) => {
                const siblingCaption = lineConfigLabel(s.configuration, 'product', t);
                return (
                  <li key={s.id}>
                    <Link to={`/stock/${s.id}`} className="text-bambu-green hover:underline">
                      {s.code}
                    </Link>
                    {siblingCaption && <span className="block text-xs text-bambu-gray">{siblingCaption}</span>}
                    <span className="block text-xs text-bambu-gray">
                      {t('stock.item.siblingFigures', { onHand: s.on_hand, available: s.available })}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={SECTION} data-testid="item-parts">
          <h2 className="text-sm font-medium text-white">{t('stock.item.parts')}</h2>
          {item.parts.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('stock.assemble.noParts')}</p>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-bambu-gray text-left">
                    <th className="font-normal p-1">{t('stock.part')}</th>
                    <th className="font-normal p-1 text-right">{t('stock.perUnit')}</th>
                    <th className="font-normal p-1 text-right">{t('stock.balance')}</th>
                  </tr>
                </thead>
                <tbody>
                  {item.parts.map((p) => (
                    <tr key={p.part_id} className="text-white">
                      <td className="p-1">{p.name}</td>
                      <td className="p-1 text-right tabular-nums">{p.per}</td>
                      <td className={`p-1 text-right tabular-nums ${p.on_shelf < p.per ? 'text-status-warning' : ''}`}>{p.on_shelf}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-sm text-bambu-gray">{t('stock.finished.canAssemble', { n: item.can_assemble })}</p>
            </>
          )}
        </section>
      </div>

      <StockJournal itemId={item.id} />

      <StockDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}
