import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardCheck } from 'lucide-react';
import { api, ApiError, type OrderPartRecount } from '../../api/client';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { invalidateOrderViews } from '../../utils/queryInvalidation';

export interface RecountDoor { orderId: number; lineId: number; product: string; onChanged?: () => void }

export function OrderPartRecountDialog({ door, onClose }: { door: RecountDoor; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['order-part-recount', door.orderId, door.lineId],
    queryFn: () => api.getOrderPartRecount(door.orderId, door.lineId), refetchOnWindowFocus: false });
  const [draft, setDraft] = useState<{ base: OrderPartRecount; values: Record<number, string> }>();
  const [reason, setReason] = useState('');
  const [review, setReview] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirmRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (review) confirmRef.current?.focus(); }, [review]);
  const base = draft?.base ?? query.data;
  const actual = (id: number, book: number) => draft?.values[id] ?? String(book);
  const valid = !!base?.parts.length && base.parts.every(p => /^\d+$/.test(actual(p.part_id, p.book)) && Number(actual(p.part_id, p.book)) <= 1_000_000);
  const changes = base?.parts.filter(p => Number(actual(p.part_id, p.book)) !== p.book) ?? [];
  function change(id: number, value: string) {
    if (!base) return;
    setDraft({ base, values: { ...(draft?.values ?? {}), [id]: value } });
    setReview(false); setAck(false); setError(undefined);
  }
  async function save() {
    if (!base || !valid || !changes.length || !reason.trim() || !ack || !review) return;
    setBusy(true); setError(undefined);
    try {
      await api.recountOrderParts(door.orderId, door.lineId, { expected_token: base.token, reason: reason.trim(),
        parts: changes.map(p => ({ part_id: p.part_id, actual: Number(actual(p.part_id, p.book)) })) });
      invalidateOrderViews(client, { orderId: door.orderId });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['project', door.orderId] }),
        client.invalidateQueries({ queryKey: ['project-plan', door.orderId] }),
      ]);
      door.onChanged?.();
      await client.invalidateQueries({ queryKey: ['order-part-recount', door.orderId] });
      onClose();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const known = ['order_recount_changed', 'order_recount_closed', 'order_recount_shared', 'order_recount_received', 'submission_pending'];
      setError(t(code && known.includes(code) ? `orderRecount.errors.${code}` : 'orderRecount.failed'));
      setReview(false); setAck(false);
    } finally { setBusy(false); }
  }
  return <Modal title={t('orderRecount.title')} icon={<ClipboardCheck className="h-5 w-5" />} size="3xl"
    onClose={() => { if (!busy) onClose(); }} footer={<div className="flex flex-wrap justify-end gap-2">
      <Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
      {review ? <Button disabled={busy || !ack} onClick={() => void save()}>{t('orderRecount.confirm')}</Button>
        : <Button disabled={busy || !valid || !changes.length || !reason.trim() || !!base?.blocked || query.isError} onClick={() => setReview(true)}>{t('orderRecount.review')}</Button>}
    </div>}>
    <div className="p-4 space-y-4 text-white">
      <h3 className="font-semibold break-words">{door.product}</h3>
      <div className="rounded-lg border border-bambu-green/40 bg-bambu-green/5 p-3 text-sm space-y-2">
        <p>{t('orderRecount.help')}</p><p>{t('orderRecount.scope')}</p><p>{t('orderRecount.history')}</p>
      </div>
      {query.isPending && <p>{t('common.loading')}</p>}
      {(query.isError || error || base?.blocked) && <div role="alert" className="rounded-lg border border-amber-500/50 p-3 text-sm space-y-2">
        <p>{error ?? (base?.blocked ? t(`orderRecount.errors.${base.blocked}`) : t('orderRecount.failed'))}</p>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setDraft(undefined); setReview(false); setAck(false); setError(undefined); void query.refetch(); }}>{t('orderRecount.reload')}</Button>
      </div>}
      {base && <div className="space-y-3">{base.parts.map(p => <div key={p.part_id} className="rounded-lg border border-bambu-dark-tertiary p-3 space-y-2">
        <p className="font-medium break-words">{p.name}</p>
        <div className="flex flex-wrap items-end gap-x-5 gap-y-2 text-sm">
          <p>{t('orderRecount.book')}: <strong className="tabular-nums">{p.book}</strong></p>
          <label className="flex flex-col gap-1">{t('orderRecount.actual')}
            <input aria-label={`${t('orderRecount.actual')}: ${p.name}`} type="number" min={0} max={1_000_000} step={1}
              className="w-32 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 tabular-nums"
              value={actual(p.part_id, p.book)} disabled={busy || !!base.blocked}
              onChange={e => change(p.part_id, e.target.value)} />
          </label>
          <p className="tabular-nums">{t('orderRecount.difference')}: <strong>{valid ? (Number(actual(p.part_id, p.book)) - p.book > 0 ? '+' : '') + (Number(actual(p.part_id, p.book)) - p.book) : '—'}</strong></p>
        </div>
        <p className="text-xs text-bambu-gray">{t('orderRecount.protected', { count: p.protected })}</p>
      </div>)}</div>}
      <label className="block space-y-1 text-sm">{t('orderRecount.reason')}
        <textarea rows={2} maxLength={1000} value={reason} disabled={busy} className="block w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2"
          onChange={e => { setReason(e.target.value); setReview(false); setAck(false); }} />
      </label>
      {review && <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 space-y-3 text-sm">
        <ul className="space-y-1">{changes.map(p => <li key={p.part_id} className="break-words">{p.name}: <strong>{p.book} → {actual(p.part_id, p.book)}</strong></li>)}</ul>
        <p>{t('orderRecount.next')}</p>
        <label className="flex items-start gap-2"><input ref={confirmRef} type="checkbox" checked={ack} disabled={busy} onChange={e => setAck(e.target.checked)} /><span>{t('orderRecount.ack')}</span></label>
      </div>}
    </div>
  </Modal>;
}
