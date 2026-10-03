import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { useProductStock } from '../../hooks/useProductStock';
import { Button } from '../Button';
import { AssembleDialog } from '../stock/AssembleDialog';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { AdjustStockDialog } from './AdjustStockDialog';

interface ProductStockProps {
  productId: number;
  /** Named by the adjust dialog's subtitle. */
  productName: string;
  /** `projects:update` — the page asks the question once and hands the answer down. */
  canEdit: boolean;
  /** The product has variant groups: the kits are counted per option (WS-13 E9 F02). */
  hasVariants?: boolean;
}

const HEAD = 'font-normal p-2';
const KV = 'grid grid-cols-[1fr_auto] gap-x-3.5 gap-y-1.5 text-sm text-bambu-gray-light';

/**
 * «Free parts» of the product page's «Stock» tab (WS-13 E9 F02): the kits the free shelf
 * makes and every counted part on it — the server's numbers, never a division re-done
 * here.
 *
 * ⚠️ **The kits are counted per option, and the counts do not add up.** Without variants
 * there is one figure, `kits_available`. With them, each `kits_by_option` row changes ONE
 * option and keeps the other groups standard — not every combination (R03) — so the rows
 * stand side by side with a note saying so.
 *
 * ⚠️ **«Assemble…» is closed only by a zero it can trust** (R03): a product without
 * variants whose shelf answered 0 kits. With variants a zero of the standard — or of any
 * single option — does not prove that no configuration can be assembled; the dialog picks
 * the configuration and its own lookup decides. A shelf still on its way, or failed, is
 * not a zero either.
 *
 * ⚠️ An empty `balances` means the product COUNTS nothing — every counted part is in the
 * answer, with a 0 where nothing has moved. So a merely empty shelf is a table of zeros
 * under a zero kit count; the sentence is only for a product with no printed part to
 * count at all. The movements are the tab's journal (F03), not a list here.
 */
export function ProductStock({ productId, productName, canEdit, hasVariants = false }: ProductStockProps) {
  const { t } = useTranslation();
  const [adjusting, setAdjusting] = useState(false);
  const [assembling, setAssembling] = useState(false);

  const { data, isError, refetch } = useProductStock(productId);
  const balances = data?.balances ?? [];
  const inKit = balances.filter((b) => b.qty_per_unit > 0);
  const outOfKit = balances.filter((b) => b.qty_per_unit === 0);
  const byOption = hasVariants ? (data?.kits_by_option ?? []) : [];
  // A zero shuts «Assemble…» only while the shelf stands behind it: after a failed re-read the
  // cached zero may be stale, and the dialog's own lookup decides (F02, R03; WS-13 E9 Codex V03).
  const noKit = !hasVariants && !isError && data != null && data.kits_available === 0;

  let body;
  if (!data) {
    body = isError ? (
      <div data-testid="stock-error">
        <LoadFailedNote role="status" message={t('stock.error')} onRetry={() => refetch()} />
      </div>
    ) : (
      <p className="flex items-center gap-2 text-sm text-bambu-gray">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('common.loading')}
      </p>
    );
  } else if (balances.length === 0) {
    body = (
      <>
        {isError && <RefreshFailedNote onRetry={() => refetch()} />}
        <p className="text-sm text-bambu-gray" data-testid="stock-no-counted-parts">
          {t('stock.noCountedParts')}
        </p>
      </>
    );
  } else {
    body = (
      <div className="space-y-3">
        {isError && <RefreshFailedNote onRetry={() => refetch()} />}
        {byOption.length > 0 ? (
          <div className="space-y-1">
            <dl data-testid="stock-kits-by-option" className={KV}>
              {byOption.map((row) => (
                <div key={`${row.group_id}-${row.option_id}`} className="contents">
                  <dt>{t('products.detail.stockTab.kitsOption', { group: row.group_name, option: row.option_name })}</dt>
                  <dd className="text-right font-medium tabular-nums text-white">{row.kits}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-bambu-gray">{t('products.detail.stockTab.kitsNote')}</p>
          </div>
        ) : (
          <dl className={KV}>
            <dt>{t('products.detail.stockTab.kits')}</dt>
            <dd data-testid="stock-kits" className="text-right font-medium tabular-nums text-white">
              {data.kits_available}
            </dd>
          </dl>
        )}

        {inKit.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-bambu-dark-tertiary">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-bambu-gray text-left">
                  <th className={HEAD}>{t('stock.part')}</th>
                  <th className={HEAD}>{t('stock.perUnit')}</th>
                  <th className={HEAD}>{t('stock.balance')}</th>
                  <th className={HEAD}>{t('stock.heldForOrders')}</th>
                </tr>
              </thead>
              <tbody>
                {inKit.map((b) => (
                  <tr key={b.part_id} className="border-t border-bambu-dark-tertiary text-white">
                    <td className="p-2">{b.name}</td>
                    <td className="p-2 tabular-nums">{`× ${b.qty_per_unit}`}</td>
                    <td className="p-2 tabular-nums" data-testid={`stock-balance-${b.part_id}`}>
                      {b.balance}
                    </td>
                    <td className="p-2 tabular-nums" data-testid={`stock-held-${b.part_id}`}>
                      {b.held_for_orders ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* A zero in the kit is a part out of the kit: it has a shelf and makes no kit
            (spec workshop-order-issue-followups, rule 34) — its own group, no per-unit column. */}
        {outOfKit.length > 0 && (
          <div className="space-y-1" data-testid="stock-out-of-kit">
            <h4 className="text-xs text-bambu-gray">{t('stock.outOfKit')}</h4>
            <div className="overflow-x-auto rounded-xl border border-bambu-dark-tertiary">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-bambu-gray text-left">
                    <th className={HEAD}>{t('stock.part')}</th>
                    <th className={HEAD}>{t('stock.balance')}</th>
                    <th className={HEAD}>{t('stock.heldForOrders')}</th>
                  </tr>
                </thead>
                <tbody>
                  {outOfKit.map((b) => (
                    <tr key={b.part_id} className="border-t border-bambu-dark-tertiary text-white">
                      <td className="p-2">{b.name}</td>
                      <td className="p-2 tabular-nums" data-testid={`stock-balance-${b.part_id}`}>
                        {b.balance}
                      </td>
                      <td className="p-2 tabular-nums" data-testid={`stock-held-${b.part_id}`}>
                        {b.held_for_orders ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="space-y-3 rounded-xl border border-bambu-dark-tertiary px-4 py-3.5" data-testid="product-stock">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-base font-semibold text-white">{t('products.detail.stockTab.parts')}</h3>
        {canEdit && balances.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setAdjusting(true)}>
            {t('stock.adjust.open')}
          </Button>
        )}
      </div>

      {body}

      {canEdit && (
        <Button
          size="sm"
          variant="secondary"
          disabled={noKit}
          title={noKit ? t('products.detail.stockTab.noKit') : undefined}
          onClick={() => setAssembling(true)}
        >
          {t('products.detail.stockTab.assemble')}
        </Button>
      )}

      {adjusting && (
        <AdjustStockDialog productId={productId} productName={productName} onClose={() => setAdjusting(false)} />
      )}
      {assembling && <AssembleDialog productId={productId} onClose={() => setAssembling(false)} />}
    </section>
  );
}
