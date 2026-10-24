import { useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Calculator, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, ApiError, type Order, type PlanRow, type PlateFitResponse } from '../../api/client';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { Select } from '../Select';
import { formatDuration } from '../../utils/date';
import { invalidateOrderViews, invalidateQueueViews } from '../../utils/queryInvalidation';
import { useAuth } from '../../contexts/AuthContext';

export interface PlateFitDraft { orderId: number; lineId: number; quantity: number; rows: PlanRow[]; revision: number; planSignature: string }
export interface PlateFitDoor {
  orderId: number; lineId?: number;
  selectedPlates?: Record<number, number[]>;
  onApplied: (draft: PlateFitDraft) => void;
}

/** Mounted only by the page's existing order-action host. Applying never
 * enqueues new work. Reviewed pending removals share the line transaction.
 * The returned counts are an ordinary
 * plan-editor draft, with the same lifetime as manually edited counts. */
export function PlateFitDialog({ door, onClose }: { door: PlateFitDoor; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const order = useQuery({ queryKey: ['plate-fit-order', door.orderId], queryFn: () => api.getOrder(door.orderId), staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false });
  const [lineId, setLineId] = useState(door.lineId);
  const [typed, setTyped] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<PlateFitResponse | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [ack, setAck] = useState(false);
  const [replacePending, setReplacePending] = useState(false);
  const [extendedSearch, setExtendedSearch] = useState(false);
  const extendedHelpId = useId();
  const [queueAck, setQueueAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Order | null>(null);
  const [needsRecalculation, setNeedsRecalculation] = useState(false);
  const sequence = useRef(0);
  const lines = order.data?.lines.filter(l => l.mode !== 'parts') ?? [];
  const line = lines.find(l => l.id === lineId) ?? (lineId == null ? lines[0] : undefined);
  const quantity = Number(typed ?? line?.quantity ?? '');
  const current = data?.options.find(o => o.quantity === selected);
  const change = current && data ? current.quantity - data.current_quantity : 0;
  const large = data != null && Math.abs(change) * 100 > data.current_quantity * 10;
  const removedCount = data?.removable_auto_ids.length ?? 0;
  const takesStock = !!current?.parts.some(p => (p.free_stock ?? 0) > 0);
  const cannotTakeStock = takesStock && !hasPermission('stock:move');
  const delta = (n: number) => `${n > 0 ? '+' : ''}${n.toLocaleString()}`;
  const reset = () => { sequence.current++; setData(null); setSelected(null); setAck(false); setQueueAck(false); setError(null); };
  const choose = (value: number) => { setSelected(value); setAck(false); setQueueAck(false); setError(null); };
  const showError = (e: unknown) => {
    const code = e instanceof ApiError ? e.code?.replace(/^plate_fit_/, '') : undefined;
    const known = ['banked_output', 'stale', 'large_change', 'queue_change', 'plates', 'ambiguous_output', 'unmapped_output', 'parts_line', 'composition', 'busy', 'invalid_plan', 'order_closed'];
    setError(code && known.includes(code) ? t(`plateFit.errors.${code}`) : e instanceof Error ? e.message : t('plateFit.failed'));
  };
  const calculate = async (around = quantity, more = expanded) => {
    if (!line || !Number.isSafeInteger(around) || around < 1 || around > 1_000_000) return;
    const request = ++sequence.current;
    setBusy(true); setError(null); setData(null); setSelected(null); setAck(false); setQueueAck(false);
    try {
      const result = await api.getPlateFit(door.orderId, line.id, { around, plate_ids: door.selectedPlates?.[line.id], steps: more ? 3 : 1, ...(replacePending ? { replace_pending: true } : {}), ...(extendedSearch ? { extended_search: true } : {}) });
      if (request !== sequence.current) return;
      setData(result);
      const preferred = result.options.find(o => o.quantity === around) ?? result.options.find(o => o.quantity > around) ?? result.options.at(-1);
      setSelected(preferred?.quantity ?? null);
    } catch (e) { if (request === sequence.current) showError(e); }
    finally { if (request === sequence.current) setBusy(false); }
  };
  const apply = async () => {
    if (!line || !data || !current || (large && !ack) || (removedCount > 0 && !queueAck)) return;
    setBusy(true); setError(null);
    let persisted = saved;
    try {
      if (!persisted) {
        const updated = await api.updateOrderLine(door.orderId, line.id, { quantity: current.quantity, plate_fit: {
          basis: data.basis, plate_ids: data.plate_ids, runs: current.runs, acknowledge_large_change: ack,
          ...(replacePending ? { replace_pending: true, acknowledge_queue_change: queueAck } : {}),
        } });
        setSaved(updated);
        persisted = updated;
        qc.setQueryData(['project', door.orderId], updated);
        invalidateOrderViews(qc);
        if (removedCount > 0) {
          invalidateQueueViews(qc);
          qc.invalidateQueries({ queryKey: ['auto-queue'] });
        }
      }
      // A failed plan read retries only this read, never a saved quantity PATCH.
      await qc.cancelQueries({ queryKey: ['project-plan', door.orderId], exact: true });
      const plan = await api.getOrderPlan(door.orderId);
      qc.setQueryData(['project-plan', door.orderId], plan);
      const baseline = plan.lines.find(l => l.line_id === line.id);
      if (!baseline || current.parts.some(p => (baseline.outstanding_before.find(v => v.part_id === p.part_id)?.count ?? 0) !== p.new_printed)
        || baseline.outstanding_before.some(p => !current.parts.some(v => v.part_id === p.part_id))) {
        setNeedsRecalculation(true);
        throw new ApiError(t('plateFit.errors.stale'), 409, 'plate_fit_stale');
      }
      const rows: PlanRow[] = current.runs.map(run => {
        const plate = data.plates.find(p => p.plate_id === run.plate_id)!;
        return { ...plate, count: run.count, useful: [], cost: null, time_unknown: !plate.print_time_seconds, alternatives: [] };
      });
      door.onApplied({ orderId: door.orderId, lineId: line.id, quantity: current.quantity, rows, revision: Date.now(), planSignature: JSON.stringify(baseline) });
      onClose();
    } catch (e) {
      // A refused apply means the reviewed proposal no longer holds — its re-check ran out of time (busy, which a
      // plain retry does not cure), or the farm or the order moved (stale, invalid_plan). Drop the whole review, so
      // nothing of it can be chosen and applied again without a new calculation; a saved PATCH is never in here.
      const refused = !persisted && e instanceof ApiError && ['plate_fit_busy', 'plate_fit_stale', 'plate_fit_invalid_plan'].includes(e.code ?? '');
      if (refused) { sequence.current++; setData(null); setSelected(null); setAck(false); setQueueAck(false); }
      if (refused && e.code === 'plate_fit_busy') setError(t('plateFit.errors.applyBusy'));
      else showError(e);
      if (!persisted && e instanceof ApiError && e.status === 409) { setSelected(null); setAck(false); }
    } finally { setBusy(false); }
  };
  const index = data?.options.findIndex(o => o.quantity === selected) ?? -1;
  const nearest = data?.options.filter(o => o.quantity === data.around || o.quantity === data.options.filter(v => v.quantity < data.around).at(-1)?.quantity || o.quantity === data.options.find(v => v.quantity > data.around)?.quantity) ?? [];
  const options = expanded ? data?.options ?? [] : nearest;
  const selectedPlateIds = line ? door.selectedPlates?.[line.id] : undefined;
  return <Modal title={t('plateFit.nearest')} icon={<Calculator className="w-5 h-5" />} size="3xl"
    onClose={() => { sequence.current++; onClose(); }} closeDisabled={busy}
    footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
      {needsRecalculation ? <Button onClick={onClose} disabled={busy}>{t('plateFit.closeToRecalculate')}</Button> :
      <Button onClick={() => void apply()} disabled={busy || !current || (large && !ack) || (removedCount > 0 && !queueAck) || cannotTakeStock}>
        {saved ? t('plateFit.retryPlan') : t(removedCount > 0 ? 'plateFit.applyQueue' : 'plateFit.apply', { quantity: selected?.toLocaleString() ?? '—', count: removedCount })}
      </Button>}</div>}>
    <div className="p-4 space-y-4">
      <p className="text-sm text-bambu-gray">{t('plateFit.explanation')}</p>
      {order.isError && <p role="alert">{t('plateFit.failed')} <Button variant="secondary" onClick={() => void order.refetch()}>{t('plateFit.retry')}</Button></p>}
      {order.isPending && <p role="status">{t('common.loading')}</p>}
      {order.data && <>
        <label className="block text-sm">{t('plateFit.line')}
          <Select className="mt-1 w-full" value={line?.id ?? ''} disabled={busy || !!saved}
            onChange={e => { reset(); setLineId(Number(e.target.value)); setTyped(null); }}>
            {lines.map(l => <option key={l.id} value={l.id}>{l.product_name} · #{l.id} · {l.quantity.toLocaleString()}</option>)}
          </Select>
        </label>
        {line && <p className="text-sm font-medium">{line.product_name} · {t('plateFit.current', { quantity: line.quantity.toLocaleString() })}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm flex-1 min-w-40">{t('plateFit.wanted')}
            <input type="number" min={1} max={1_000_000} step={1} className="mt-1 block w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-2 text-white tabular-nums"
              value={typed ?? line?.quantity ?? ''} disabled={busy || !!saved} onChange={e => { reset(); setTyped(e.target.value); }} />
          </label>
          <Button variant="secondary" disabled={busy || !!saved || order.isFetching || !line || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000}
            onClick={() => void calculate()}>{busy ? t('common.loading') : t('plateFit.calculate')}</Button>
        </div>
        <div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 accent-bambu-green" aria-describedby={extendedHelpId}
              checked={extendedSearch} disabled={busy || !!saved}
              onChange={e => { reset(); setExpanded(false); setExtendedSearch(e.target.checked); }} />
            {t('plateFit.extendedSearch')}
          </label>
          <p id={extendedHelpId} className="mt-1 text-xs text-bambu-gray">{t('plateFit.extendedSearchHint')}</p>
        </div>
        {busy && !data && !saved && <p role="status" className="text-sm text-bambu-gray">{t('plateFit.searching', { seconds: extendedSearch ? 30 : 6 })}</p>}
        <p className="text-xs text-bambu-gray">{t('plateFit.platesScope', { count: selectedPlateIds?.length ?? data?.plate_ids.length ?? 0 })}</p>
        {hasPermission('queue:delete_all') && hasPermission('queue:read') && <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 accent-bambu-green" checked={replacePending} disabled={busy || !!saved} onChange={e => { reset(); setReplacePending(e.target.checked); }} />
          {t('plateFit.replacePending')}
        </label>}
      </>}
      {data && <>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('plateFit.results')}>
          {options.map(o => <Button key={o.quantity} variant={selected === o.quantity ? 'primary' : 'secondary'} disabled={busy || !!saved} onClick={() => choose(o.quantity)}>
            {o.quantity.toLocaleString()} · {delta(o.quantity - data.current_quantity)} ({delta(Math.round((o.quantity - data.current_quantity) / data.current_quantity * 1000) / 10)}%)
          </Button>)}
        </div>
        {!expanded && <Button variant="secondary" disabled={busy || !!saved} onClick={() => { setExpanded(true); void calculate(data.around, true); }}>
          {t('plateFit.showMore')}
        </Button>}
        {expanded && data.options.length > 1 && <div className="flex items-center gap-3">
          <Button variant="secondary" aria-label={t('plateFit.previous')} disabled={busy || !!saved || index <= 0} onClick={() => choose(data.options[index - 1].quantity)}><ChevronLeft className="w-4 h-4" /></Button>
          <input aria-label={t('plateFit.results')} type="range" className="flex-1 accent-bambu-green" min={0} max={data.options.length - 1} step={1} value={Math.max(0, index)} disabled={busy || !!saved} onChange={e => choose(data.options[Number(e.target.value)].quantity)} />
          <Button variant="secondary" aria-label={t('plateFit.next')} disabled={busy || !!saved || index < 0 || index >= data.options.length - 1} onClick={() => choose(data.options[index + 1].quantity)}><ChevronRight className="w-4 h-4" /></Button>
        </div>}
        {expanded && data.options.length > 0 && <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="secondary" disabled={busy || !!saved} onClick={() => { const n = data.options[0].quantity; setTyped(String(n)); void calculate(n); }}>{t('plateFit.moreBelow')}</Button>
          <Button size="sm" variant="secondary" disabled={busy || !!saved} onClick={() => { const n = data.options.at(-1)!.quantity; setTyped(String(n)); void calculate(n); }}>{t('plateFit.moreAbove')}</Button>
        </div>}
        {data.options.length === 0 && <p role="status">{t('plateFit.noExact')}</p>}
        {(['lower', 'upper', 'current'] as const).some(k => data[k] === 'limited') && <p role="status" className="text-amber-700 dark:text-amber-300">{t('plateFit.limited')}</p>}
        {(data.lower === 'none' || data.upper === 'none') && <p className="text-xs text-bambu-gray">{t('plateFit.bounds', { quantity: data.quantity_limit.toLocaleString() })}</p>}
      </>}
      {current && data && <>
        {removedCount > 0 && <div className="rounded-xl border border-amber-600 dark:border-amber-500 bg-amber-500/10 p-4 text-sm">
          <p className="font-semibold">{t('plateFit.queueWarning', { count: removedCount })}</p>
          <details className="mt-2"><summary>{t('plateFit.queueIds')}</summary><p className="break-words">{data.removable_auto_ids.map(id => `#${id}`).join(', ')}</p></details>
          <label className="mt-3 flex items-start gap-2"><input type="checkbox" className="mt-1 accent-bambu-green" checked={queueAck} disabled={busy || !!saved} onChange={e => setQueueAck(e.target.checked)} />{t('plateFit.queueAck', { count: removedCount })}</label>
        </div>}
        <div className={`rounded-xl border p-4 ${large ? 'border-amber-600 dark:border-amber-500 bg-amber-500/10' : 'border-bambu-dark-tertiary'}`}>
          <p className="text-xl font-semibold tabular-nums">{data.current_quantity.toLocaleString()} → {current.quantity.toLocaleString()}</p>
          <p className="font-semibold tabular-nums">{delta(change)} · {delta(Math.round(change / data.current_quantity * 1000) / 10)}%</p>
          <p className="mt-2 text-sm">{t('plateFit.summary', { runs: current.runs.reduce((n, r) => n + r.count, 0), time: current.print_time_seconds == null ? '—' : formatDuration(current.print_time_seconds), grams: current.filament_used_grams?.toFixed(1) ?? '—' })}</p>
          {large && <>
            <p role="alert" className="mt-3 font-semibold text-amber-800 dark:text-amber-200">{t('plateFit.warning')}</p>
            <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={ack} disabled={busy || !!saved} onChange={e => setAck(e.target.checked)} className="mt-1 accent-bambu-green" />
              {t('plateFit.ack', { from: data.current_quantity.toLocaleString(), to: current.quantity.toLocaleString(), percent: delta(Math.round(change / data.current_quantity * 1000) / 10) })}</label>
          </>}
        </div>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-bambu-gray">
          {['part', 'required', 'allocated', 'completed', 'printing', 'queued', 'otherCoverage', 'freeStock', 'newPrinted'].map(key => <th key={key} className="p-2 font-normal">{t(`plateFit.columns.${key}`)}</th>)}
        </tr></thead><tbody>{current.parts.map(p => <tr key={p.part_id} className="border-t border-bambu-dark-tertiary">
          <td className="p-2">{p.name}</td>{[p.required, p.allocated, p.completed, p.printing, p.queued, p.other_coverage ?? 0, p.free_stock ?? 0, p.new_printed].map((n, i) => <td key={i} className="p-2 tabular-nums">{n.toLocaleString()}</td>)}
        </tr>)}</tbody></table></div>
        <details className="text-sm"><summary className="cursor-pointer text-bambu-green">{t('plateFit.files')}</summary><ul className="mt-2 space-y-1">{current.runs.map(r => {
          const plate = data.plates.find(p => p.plate_id === r.plate_id);
          return <li key={r.plate_id} className="break-words">{plate?.filename ?? t('plateFit.hidden')} · {plate?.printer_model ?? '—'} · ×{r.count.toLocaleString()}</li>;
        })}</ul></details>
        {current.runs.some(r => r.count > 999) && <p className="text-amber-700 dark:text-amber-300">{t('plateFit.batchLimit')}</p>}
        <p className="text-xs text-bambu-gray">{t('plateFit.draft')}</p>
        <p className="text-xs text-bambu-gray">{t('plateFit.coverageHint')}</p>
        {takesStock && <p className="text-sm font-medium text-bambu-green">{t('plateFit.stockTake', { ready: current.from_finished ?? 0, kits: current.from_kits ?? 0, parts: Object.values(current.stock_parts ?? {}).reduce((a, b) => a + b, 0) })}</p>}
        {cannotTakeStock && <p role="alert" className="text-amber-700 dark:text-amber-300">{t('plateFit.stockPermission')}</p>}
      </>}
      {saved && <p role="status">{t('plateFit.saved')}</p>}
      {needsRecalculation && <p role="status">{t('plateFit.savedDemandChanged')}</p>}
      {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
    </div>
  </Modal>;
}
