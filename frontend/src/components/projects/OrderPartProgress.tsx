import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { OrderPartProgress as Progress, OrderPartProgressRow, PartContribution } from '../../api/client';

const segments = [
  ['allocated_stock_qty', 'stock', 'bg-blue-500'],
  ['completed_good_qty', 'good', 'bg-green-500'],
  ['printing_qty', 'printing', 'bg-yellow-400'],
  ['queued_qty', 'queued', 'bg-purple-500'],
] as const;

function Contribution({ item }: { item: PartContribution }) {
  const { t } = useTranslation();
  return <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-xs">
    <span className="break-all text-white">{item.filename || t('orders.partProgress.unknownFile')}</span>
    <span>{t('orders.partProgress.source.' + item.source_kind)} #{item.source_id}</span>
    {item.recipe_id != null && <span>{t('orders.partProgress.recipe')} #{item.recipe_id}</span>}
    {item.plate_index != null && <span>{t('orders.partProgress.plate')} {item.plate_index}</span>}
    <span>{t('orders.partProgress.runs')}: {item.runs}</span>
    <span>{t('orders.partProgress.expected')}: {item.expected_qty ?? '—'}</span>
    {item.source_kind !== 'recipe' && <span>
      {t('orders.partProgress.good')} {item.completed_good_qty} · {t('orders.partProgress.printing')} {item.printing_qty} · {t('orders.partProgress.queued')} {item.queued_qty}
    </span>}
    {item.rejected_qty > 0 && <span className="text-red-600 dark:text-red-400">{t('orders.partProgress.rejected')} {item.rejected_qty}</span>}
  </li>;
}

function PartRow({ part }: { part: OrderPartProgressRow }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  // Only geometric clipping belongs to the client. All quantities/formulas come from API.
  let room = Math.max(0, part.required_qty);
  const widths = segments.map(([key]) => {
    const shown = Math.min(room, Math.max(0, part[key]));
    room -= shown;
    return part.required_qty > 0 ? shown / part.required_qty * 100 : 0;
  });
  const summary = t('orders.partProgress.summary', {
    secured: part.secured_qty, required: part.required_qty,
    printing: part.printing_qty, queued: part.queued_qty, remaining: part.remaining_qty,
  });
  return <div className="border-b border-bambu-dark-tertiary last:border-b-0" data-testid={`progress-${part.order_line_id}-${part.part_id}`}>
    <button type="button" className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-bambu-dark-tertiary/30"
      aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(!expanded)}>
      {expanded ? <ChevronDown className="mt-1 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-1 h-4 w-4 shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-white">{part.part_name}</span>
        <span className="block text-xs text-bambu-gray">{part.product_name} · {t('orders.partProgress.line')} #{part.order_line_id}</span>
        <span className="mt-1 block text-sm text-white">{summary}</span>
        <span className="mt-2 flex h-2 overflow-hidden rounded-full bg-gray-600" role="progressbar"
          aria-label={part.part_name} aria-valuemin={0} aria-valuemax={part.required_qty}
          aria-valuenow={Math.min(part.secured_qty, part.required_qty)} aria-valuetext={summary}>
          {segments.map(([key, label, color], i) => <span key={key} className={color}
            data-segment={key} style={{ width: `${widths[i]}%` }}
            title={`${t('orders.partProgress.' + label)}: ${part[key]}`} />)}
        </span>
        <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-bambu-gray">
          <span>{t('orders.partProgress.stock')} {part.allocated_stock_qty}</span>
          <span>{t('orders.partProgress.good')} {part.completed_good_qty}</span>
          <span className={part.rejected_qty > 0 ? 'text-red-600 dark:text-red-400' : ''}>{t('orders.partProgress.rejected')} {part.rejected_qty}</span>
          <span>{t('orders.partProgress.free')} {part.free_stock_qty}</span>
        </span>
      </span>
    </button>
    {expanded && <div id={detailId} className="border-t border-bambu-dark-tertiary px-6 py-2 text-bambu-gray">
      <p className="text-xs">{t('orders.partProgress.recipeNote')}</p>
      {part.contributions.length ? <ul className="divide-y divide-bambu-dark-tertiary">
        {part.contributions.map((item, i) => <Contribution key={`${item.source_kind}-${item.source_id}-${i}`} item={item} />)}
      </ul> : <p className="py-2 text-xs">{t('orders.partProgress.noContributions')}</p>}
    </div>}
  </div>;
}

/** Presentation of the server projection; also used by the isolated synthetic preview. */
export function OrderPartProgressContent({ data }: { data: Progress }) {
  const { t } = useTranslation();
  return <>
    {data.scope_limited && <p role="status" className="px-4 pt-3 text-sm text-yellow-700 dark:text-yellow-400">{t('orders.partProgress.limited')}</p>}
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-xs text-bambu-gray">
      {segments.map(([key, label, color]) => <span key={key} className="flex items-center gap-1.5">
        <span className={`h-2 w-2 rounded-sm ${color}`} />{t('orders.partProgress.' + label)}
      </span>)}
      <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-gray-600" />{t('orders.partProgress.uncovered')}</span>
    </div>
    {data.parts.map((part) => <PartRow key={`${part.order_line_id}-${part.part_id}`} part={part} />)}
    {!data.parts.length && <p className="px-4 pb-4 text-sm text-bambu-gray">{t('orders.partProgress.empty')}</p>}
    <p className="px-4 py-3 text-xs text-bambu-gray">{t('orders.partProgress.stockNote')}</p>
    {data.unallocated.length > 0 && <div role="status" className="m-4 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
      <h4 className="font-medium text-yellow-700 dark:text-yellow-400">{t('orders.partProgress.unallocatedTitle')}</h4>
      <p className="mt-1 text-xs text-bambu-gray">{t('orders.partProgress.unallocatedNote')}</p>
      <ul className="mt-2 divide-y divide-bambu-dark-tertiary">
        {data.unallocated.map((item, i) => <li key={i}>
          <p className="pt-2 text-xs text-yellow-700 dark:text-yellow-400">{item.part_name} · {t('orders.partProgress.reason.' + item.reason)}
            {item.candidate_pairs.length > 0 && ` (${item.candidate_pairs.map(([line, part]) => `#${line} / #${part}`).join(', ')})`}
          </p>
          <ul><Contribution item={item} /></ul>
        </li>)}
      </ul>
    </div>}
  </>;
}

export function OrderPartProgress({ orderId }: { orderId: number }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const panelId = useId();
  const query = useQuery({
    queryKey: ['order-part-progress', orderId],
    queryFn: () => api.getOrderPartProgress(orderId),
    staleTime: 0,
    meta: { refreshToast: true },
  });
  return <section>
    <h3 className="mb-3 text-lg font-semibold text-white">
      <button type="button" className="flex items-center gap-2" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(!expanded)}>
        <Layers className="h-5 w-5" />{t('orders.partProgress.title')}
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
    </h3>
    {expanded && <div id={panelId} className="overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary">
      {query.isError ? <div role="alert" className="p-4 text-sm text-red-600 dark:text-red-400">
        {t('orders.partProgress.error')}
        <button className="ml-3 underline" onClick={() => void query.refetch()}>{t('orders.partProgress.retry')}</button>
      </div> : query.data ? <OrderPartProgressContent data={query.data} /> : <p className="p-4 text-sm text-bambu-gray">{t('orders.partProgress.loading')}</p>}
    </div>}
  </section>;
}
