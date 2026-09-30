import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { AlertTriangle } from 'lucide-react';
import type { PlanPartCount } from '../../api/client';

interface PlanUnsatisfiableProps {
  lineId: number;
  productId: number;
  material: string | null;
  part: PlanPartCount;
  /** The product's files that are linked but not sliced — the likely reason, said
   *  beside the link (WS-13 E4 E10). */
  notSliced: string[];
}

/**
 * A part the line still needs that no candidate plate makes at all (WS-13 E4 E10) —
 * an amber block under the group's table.
 *
 * This is not "the plan fell short" — the greedy covered everything it could, and
 * there is simply nothing to print for this part in this material yet. So the block
 * offers the two things that would change that: the product's files, where a plate
 * is linked, and the slice slot, which is **reserved and disabled** (pass-3 scope).
 * The disabled button is kept rather than dropped so the answer to "why can't I just
 * slice it here" is on screen instead of absent.
 *
 * ⚠️ **The test id carries the LINE id beside the part's**, exactly as `PlanRow`'s
 * does: a `ProductPart.id` is unique per product, not per order.
 */
export function PlanUnsatisfiable({ lineId, productId, material, part, notSliced }: PlanUnsatisfiableProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid={`plan-unsatisfiable-${lineId}-${part.part_id}`}
      className="mt-2.5 flex items-center gap-2 flex-wrap rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2.5 text-[13px] text-amber-700 dark:text-amber-400"
    >
      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {t('orders.plan.noPlateFor', {
          part: part.name,
          count: part.count,
          material: material ?? t('orders.plan.anyMaterial'),
        })}{' '}
        <Link to={`/products/${productId}#files`} className="underline">
          {t('orders.plan.linkFile')}
        </Link>
        {notSliced.length > 0 && ` · ${t('orders.plan.notSlicedInline', { files: notSliced.join(', ') })}`}
      </span>
      <button
        type="button"
        disabled
        title={t('orders.plan.sliceReserved')}
        className="px-2 py-1 rounded border border-bambu-dark-tertiary text-bambu-gray opacity-50 cursor-not-allowed whitespace-nowrap"
      >
        {t('orders.plan.slice')}
      </button>
    </div>
  );
}
