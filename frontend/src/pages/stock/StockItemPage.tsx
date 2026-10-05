import { useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ExternalLink, Plus } from 'lucide-react';
import { ApiError } from '../../api/client';
import type { StockItemDetail } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../../components/Button';
import { CardActionMenu, CardActionMenuItem } from '../../components/CardActionMenu';
import { manualReserved } from '../../components/stock/manualReservation';
import { StatTile, StatTiles } from '../../components/StatTile';
import { CONFIG_ACCENT_CLASS, lineConfigLabel } from '../../components/projects/lineConfigLabel';
import { StockDialogs } from '../../components/stock/StockDialogs';
import type { StockDialogState } from '../../components/stock/StockDialogs';
import { StockJournal } from '../../components/stock/StockJournal';
import { LoadFailedNote } from '../../components/workshop/LoadFailedNote';
import { RefreshFailedNote } from '../../components/workshop/RefreshFailedNote';
import { WorkshopPanel } from '../../components/workshop/WorkshopPanel';
import { useStockItem } from '../../hooks/useFinishedStock';
import { SectionLink } from '../../components/workshop/SectionLink';
import { useCanOpen } from '../../hooks/useCanOpen';

/** The mockup's `.m-stockgrid`: two cards side by side, one column at 1100 and below (E12 F04).
 *  ⚠️ `max-[1101px]`: Tailwind 4 writes `max-*` as `width < N`. */
const CARDS = 'grid items-start gap-4 grid-cols-[repeat(auto-fit,minmax(420px,1fr))] max-[1101px]:grid-cols-1';

/**
 * One finished-goods position (spec workshop-finished-goods, rule 25; WS-13 E12 F): the
 * header with its receipt and its menu, the four tiles, what the position needs and the
 * moves that answer it, who holds it and the product's other configurations, the free
 * parts under this one, and its own journal.
 *
 * Every figure is the server's detail — nothing here adds a column up. Data before status,
 * as on every detail page: a first read is a skeleton, a failed one an alert with its
 * retry, a position that is gone says so with the way back, and a failed re-read keeps the
 * position on screen under a note (the hook's toast is off — it would say it twice).
 */
export function StockItemPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const itemId = Number(id);
  const valid = Number.isInteger(itemId) && itemId > 0;
  const { data: item, isError, error, refetch } = useStockItem(itemId);

  if (!item) {
    const gone = !valid || (error instanceof ApiError && error.status === 404);
    if (gone) {
      return (
        <div className="workshop p-4">
          <WorkshopPanel>
            <p className="mb-2 text-base font-semibold text-white">{t('stock.item.notFound')}</p>
            <Link to="/stock" className="text-sm text-bambu-green hover:underline">
              {t('stock.item.backToStock')}
            </Link>
          </WorkshopPanel>
        </div>
      );
    }
    if (isError) {
      return (
        <div className="workshop p-4">
          <LoadFailedNote message={t('stock.item.loadFailed')} onRetry={() => refetch()} />
        </div>
      );
    }
    return (
      <div className="workshop p-4">
        <div role="status" aria-busy="true" data-testid="item-skeleton" className="space-y-4">
          <span className="sr-only">{t('common.loading')}</span>
          <div aria-hidden className="animate-pulse space-y-4">
            <div className="h-4 w-40 rounded bg-bambu-dark-tertiary" />
            <div className="h-8 w-72 rounded bg-bambu-dark-tertiary" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-24 rounded-xl bg-bambu-dark-secondary" />
              ))}
            </div>
            <div className="h-24 rounded-xl bg-bambu-dark-secondary" />
          </div>
        </div>
      </div>
    );
  }

  return <PositionView item={item} refreshFailed={isError} onRetry={() => refetch()} />;
}

function PositionView({ item, refreshFailed, onRetry }: { item: StockItemDetail; refreshFailed: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('stock:move');
  // A count is a correction of the books — `stock:adjust` (WS-13 E13 O06).
  const canAdjust = hasPermission('stock:adjust');
  // The product is the catalog's: a storekeeper without its read gets no way there (O19).
  const productPath = `/products/${item.product.id}`;
  const canOpenProduct = useCanOpen()(productPath);
  const heading = useRef<HTMLHeadingElement>(null);
  const [dialog, setDialog] = useState<StockDialogState>(null);
  const caption = lineConfigLabel(item.configuration, 'product', t);

  const minSub = item.below_min
    ? t('stock.item.tiles.minShort', { n: item.short_by })
    : item.min_qty > 0
      ? t('stock.item.tiles.minWithin')
      : t('stock.item.tiles.minNotSet');

  return (
    <div className="workshop p-4 space-y-4">
      <nav className="flex items-center gap-1 text-sm text-bambu-gray">
        <Link to="/stock" className="hover:text-white transition-colors">
          {t('projects.tabs.stock')}
        </Link>
        <ChevronRight className="w-4 h-4" />
        <span className="text-white break-words">{item.product.name}</span>
      </nav>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 space-y-1">
          <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold text-white outline-none break-words">
            {item.product.name}
          </h1>
          <p data-testid="item-facts" className="text-sm text-bambu-gray">
            <span className="font-mono">{item.product.sku || '—'}</span>
            {' · '}
            {item.code}
            {caption && (
              <>
                {' · '}
                <span data-config-accent className={CONFIG_ACCENT_CLASS}>
                  {caption}
                </span>
              </>
            )}
            {' · '}
            {t('stock.item.location', { location: item.location ?? t('stock.finished.noLocation') })}
          </p>
          <SectionLink action to={`/products/${item.product.id}`} className="text-sm text-bambu-green hover:underline">
            {t('stock.item.openProduct')}
          </SectionLink>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button onClick={() => setDialog({ kind: 'receipt', item })}>
              <Plus className="w-4 h-4" />
              {t('stock.finished.action.receipt')}
            </Button>
          )}
          {(canAdjust || canOpenProduct) && (
            <CardActionMenu label={t('common.actions')} testId="item-menu" width={220}>
              {(close) => (
                <>
                  {canAdjust && (
                    <CardActionMenuItem
                      onSelect={() => {
                        setDialog({ kind: 'stocktake', item });
                        close();
                      }}
                    >
                      {t('stock.finished.action.stocktake')}
                    </CardActionMenuItem>
                  )}
                  {canOpenProduct && (
                    <CardActionMenuItem
                      onSelect={() => {
                        close();
                        navigate(productPath);
                      }}
                    >
                      {t('stock.item.openProduct')}
                    </CardActionMenuItem>
                  )}
                </>
              )}
            </CardActionMenu>
          )}
        </div>
      </header>

      {refreshFailed && <RefreshFailedNote onRetry={onRetry} />}

      <StatTiles>
        <StatTile
          testId="item-tile-on-hand"
          label={t('stock.item.tiles.onHand')}
          value={item.on_hand}
          sub={t('stock.item.tiles.onHandSub')}
        />
        <StatTile
          testId="item-tile-reserved"
          label={t('stock.item.tiles.reserved')}
          value={item.reserved}
          sub={t('stock.item.tiles.reservedSub')}
        />
        <StatTile
          testId="item-tile-available"
          label={t('stock.item.tiles.available')}
          value={item.available}
          tone={item.below_min ? 'warn' : undefined}
          sub={t('stock.item.tiles.availableSub')}
        />
        <StatTile
          testId="item-tile-min"
          label={t('stock.item.tiles.min')}
          value={item.min_qty > 0 ? item.min_qty : '—'}
          sub={minSub}
        />
      </StatTiles>

      <ActionsPanel item={item} canEdit={canEdit} canAdjust={canAdjust} onDialog={setDialog} />

      <div data-testid="item-cards" className={CARDS}>
        <WorkshopPanel title={t('stock.item.reservations')} headingLevel={3} data-testid="item-reservations">
          {item.reservations.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('stock.item.noReservations')}</p>
          ) : (
            <ul className="text-sm text-white space-y-1">
              {item.reservations.map((r) => (
                <li key={r.project_line_id ?? 'none'}>
                  {r.project_id != null && r.project_code ? (
                    <>
                      <SectionLink to={`/projects/${r.project_id}`} className="text-bambu-green hover:underline">
                        {r.project_code}
                      </SectionLink>
                      {/* The order's name beside its code, as the mockup has it (F6 D2). */}
                      {r.project_name && <span>{` · ${r.project_name}`}</span>}
                      <span className="tabular-nums">{` — ${t('stock.item.qty', { n: r.qty })}`}</span>
                    </>
                  ) : (
                    t('stock.item.withoutOrder', { n: r.qty })
                  )}
                </li>
              ))}
            </ul>
          )}
          {item.siblings.length > 0 && (
            <>
              <h3 className="mt-4 mb-1.5 text-sm font-semibold text-white">{t('stock.item.siblings')}</h3>
              <ul className="text-sm space-y-1">
                {item.siblings.map((s) => {
                  const siblingCaption = lineConfigLabel(s.configuration, 'product', t);
                  return (
                    <li key={s.id} className="text-bambu-gray">
                      <Link to={`/stock/${s.id}`} className="text-bambu-green hover:underline">
                        {siblingCaption ? `${s.code} · ${siblingCaption}` : s.code}
                      </Link>
                      {` — ${t('stock.item.siblingAvailable', { available: s.available, onHand: s.on_hand })}`}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </WorkshopPanel>

        <WorkshopPanel title={t('stock.item.parts')} headingLevel={3} data-testid="item-parts">
          {item.parts.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('stock.assemble.noParts')}</p>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
              {item.parts.map((p) => (
                <PartRow key={p.part_id} partId={p.part_id} label={t('stock.item.partPer', { name: p.name, per: p.per })} shelf={p.on_shelf} short={p.on_shelf < p.per} />
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-bambu-gray">
            {t('stock.item.canAssemble', { n: item.can_assemble })}
            {canOpenProduct && (
              <>
                {' · '}
                <SectionLink action to={productPath} className="inline-flex items-center gap-1 text-bambu-green hover:underline">
                  {t('stock.item.productCard')}
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden />
                </SectionLink>
              </>
            )}
          </p>
        </WorkshopPanel>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-white">{t('stock.item.journal')}</h2>
        <StockJournal itemId={item.id} />
      </section>

      <StockDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

function PartRow({ partId, label, shelf, short }: { partId: number; label: string; shelf: number; short: boolean }) {
  return (
    <>
      <span className="text-white min-w-0 break-words">{label}</span>
      <b data-testid={`item-shelf-${partId}`} className={`text-right tabular-nums font-semibold ${short ? 'text-status-warning' : 'text-white'}`}>
        {shelf}
      </b>
    </>
  );
}

/**
 * What the position needs and the moves that answer it (E12 F03): the heading and the
 * mockup's sentence with the server's numbers; a greyed move says why — on screen, and to a
 * screen reader through `aria-describedby`.
 */
function ActionsPanel({
  item,
  canEdit,
  canAdjust,
  onDialog,
}: {
  item: StockItemDetail;
  canEdit: boolean;
  /** «Location and minimum» corrects the position — `stock:adjust` (WS-13 E13 O06). */
  canAdjust: boolean;
  onDialog: (dialog: StockDialogState) => void;
}) {
  const { t } = useTranslation();
  const uid = useId();
  const head = item.below_min
    ? t('stock.item.panel.needs')
    : item.min_qty > 0
      ? t('stock.item.panel.within')
      : t('stock.item.panel.noMin');
  const text = item.below_min
    ? t('stock.item.panel.needsText', { short: item.short_by, kits: item.can_assemble })
    : t('stock.item.panel.freeText');

  // What the stock dialogs may move is the manual reservation only (R03): with only orders'
  // reservations a release or an issue has nothing to take here (final review M6).
  const manual = manualReserved(item.reservations);
  const actions: { kind: Exclude<NonNullable<StockDialogState>['kind'], 'receipt' | 'stocktake'>; label: string; reason?: string }[] = [
    {
      kind: 'assemble',
      label: t('stock.finished.action.assemble'),
      reason: item.can_assemble <= 0 ? t('stock.item.noKits') : undefined,
    },
    {
      kind: 'reserve',
      label: t('stock.finished.action.reserve'),
      reason: item.available <= 0 ? t('stock.finished.disabled.reserve') : undefined,
    },
    {
      kind: 'release',
      label: t('stock.finished.action.release'),
      reason:
        item.reserved <= 0
          ? t('stock.finished.disabled.release')
          : manual <= 0
            ? t('stock.item.releaseNoManual')
            : undefined,
    },
    {
      kind: 'issue',
      label: t('stock.finished.action.issue'),
      reason:
        item.on_hand <= 0
          ? t('stock.finished.disabled.issue')
          : item.available <= 0 && manual <= 0
            ? t('stock.item.issueAllHeld')
            : undefined,
    },
    ...(canAdjust ? [{ kind: 'params' as const, label: t('stock.finished.action.params') }] : []),
  ];
  const disabled = actions.filter((a) => a.reason);

  return (
    <WorkshopPanel data-testid="item-actions">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h3 className={`text-base font-semibold ${item.below_min ? 'text-status-warning' : 'text-white'}`}>{head}</h3>
          <p className="text-sm text-bambu-gray">{text}</p>
        </div>
        {canEdit && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              {actions.map((a) => (
                <Button
                  key={a.kind}
                  size="sm"
                  variant="secondary"
                  disabled={a.reason !== undefined}
                  aria-describedby={a.reason ? `${uid}-${a.kind}` : undefined}
                  onClick={() => onDialog({ kind: a.kind, item })}
                >
                  {a.label}
                </Button>
              ))}
            </div>
            {disabled.length > 0 && (
              <ul className="text-xs text-bambu-gray space-y-0.5">
                {disabled.map((a) => (
                  <li key={a.kind} id={`${uid}-${a.kind}`}>
                    {a.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </WorkshopPanel>
  );
}
