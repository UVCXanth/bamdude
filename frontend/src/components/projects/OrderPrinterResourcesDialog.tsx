import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Printer } from 'lucide-react';
import { api, ApiError, type OrderPrinterResources, type OrderResourceProposal } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { Modal } from '../Modal';
import { Button } from '../Button';
import type { OrderResourceDoor } from './OrderPrinterResources';
import { invalidateOrderViews, invalidateQueueViews } from '../../utils/queryInvalidation';

export function OrderPrinterResourcesDialog({ door, onClose }: { door: OrderResourceDoor; onClose: () => void }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['order-printer-resources', door.orderId], queryFn: () => api.getOrderPrinterResources(door.orderId) });
  const [edited, setEdited] = useState<OrderPrinterResources>();
  const [editingToken, setEditingToken] = useState<string>();
  const [proposal, setProposal] = useState<OrderResourceProposal>();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [search, setSearch] = useState('');
  const resources = edited ?? query.data?.resources ?? { models: null, printer_ids: null };
  const dirty = !!query.data && JSON.stringify(resources) !== JSON.stringify(query.data.resources);
  const canReplan = hasPermission('queue:delete_all') && hasPermission('queue:read_all');
  const change = (value: OrderPrinterResources) => {
    if (!edited) setEditingToken(query.data?.token);
    setEdited(value); setProposal(undefined); setAck(false); setNotice(undefined); setError(undefined);
  };
  const invalidate = async () => {
    await client.invalidateQueries({ queryKey: ['order-printer-resources', door.orderId] });
    invalidateOrderViews(client, { orderId: door.orderId });
    invalidateQueueViews(client);
    door.onChanged();
  };
  const failed = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : undefined;
    const known = ['order_resources_changed', 'order_resources_preparing', 'order_resources_no_plan', 'plan_conflict', 'submission_pending'];
    setError(t(code && known.includes(code) ? `orderResources.errors.${code}` : 'orderResources.failed'));
    setProposal(undefined); setAck(false);
  };
  async function save() {
    if (!query.data) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const saved = await api.updateOrderPrinterResources(door.orderId, editingToken ?? query.data.token, resources);
      client.setQueryData(['order-printer-resources', door.orderId], saved);
      setEdited(undefined); setEditingToken(undefined); setProposal(undefined); setAck(false);
      await invalidate(); setNotice(t('orderResources.saved'));
    } catch (e) { failed(e); } finally { setBusy(false); }
  }
  async function preview() {
    setBusy(true); setError(undefined); setNotice(undefined); setAck(false);
    try {
      const working = await api.getWorkingPlan(door.orderId);
      setProposal(await api.previewOrderResourceReplan(door.orderId, working.revision));
    } catch (e) { failed(e); } finally { setBusy(false); }
  }
  async function apply() {
    if (!proposal || !ack) return;
    setBusy(true); setError(undefined);
    try {
      await api.applyOrderResourceReplan(door.orderId, proposal);
      setProposal(undefined); setAck(false);
      await invalidate(); setNotice(t('orderResources.applied'));
    } catch (e) { failed(e); } finally { setBusy(false); }
  }
  const models = [...new Set([...(query.data?.printers.flatMap(p => p.model ? [p.model] : []) ?? []), ...(resources.models ?? [])])].sort();
  const eligible = query.data?.printers.filter(p => (!resources.models || !!p.model && resources.models.includes(p.model)) && (!resources.printer_ids || resources.printer_ids.includes(p.id))) ?? [];
  const invalid = resources.models?.length === 0 || resources.printer_ids?.length === 0;
  return <Modal title={t('orderResources.title')} icon={<Printer className="h-5 w-5" />} size="3xl" onClose={() => { if (!busy) onClose(); }}
    footer={<Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.close')}</Button>}>
    <div className="space-y-5 p-4 text-white">
      <div className="rounded-lg border border-bambu-green/40 bg-bambu-green/5 p-3 text-sm space-y-2">
        <p>{t('orderResources.help')}</p>
        <ul className="list-disc pl-5 space-y-1"><li>{t('orderResources.intersection')}</li><li>{t('orderResources.notReserved')}</li><li>{t('orderResources.claimed')}</li></ul>
      </div>
      {query.isPending && <p>{t('common.loading')}</p>}
      {query.isError && <p role="alert">{t('orderResources.loadFailed')} <Button onClick={() => void query.refetch()}>{t('common.retry')}</Button></p>}
      {query.data && <>
        <fieldset disabled={busy} className="space-y-2">
          <legend className="font-semibold">{t('orderResources.models')}</legend>
          <label className="flex gap-2 items-center"><input type="checkbox" checked={resources.models === null} onChange={e => change({ ...resources, models: e.target.checked ? null : [] })} />{t('orderResources.allModels')}</label>
          {resources.models !== null && <div className="flex flex-wrap gap-x-5 gap-y-2">{models.map(model => <label key={model} className="flex gap-2 items-center"><input type="checkbox" checked={resources.models!.includes(model)} onChange={e => change({ ...resources, models: e.target.checked ? [...resources.models!, model].sort() : resources.models!.filter(m => m !== model) })} />{model}</label>)}</div>}
        </fieldset>
        <fieldset disabled={busy} className="space-y-2">
          <legend className="font-semibold">{t('orderResources.printers')}</legend>
          <label className="flex gap-2 items-center"><input type="checkbox" checked={resources.printer_ids === null} onChange={e => change({ ...resources, printer_ids: e.target.checked ? null : [] })} />{t('orderResources.anyPrinter')}</label>
          {resources.printer_ids !== null && <>
            <label className="block text-sm">{t('orderResources.search')}<input value={search} onChange={e => setSearch(e.target.value)} className="mt-1 w-full rounded border border-bambu-dark-tertiary bg-transparent p-2" /></label>
            <div className="max-h-56 overflow-auto rounded-lg border border-bambu-dark-tertiary p-3 grid gap-2 sm:grid-cols-2">{query.data.printers.filter(p => `${p.name} ${p.model ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(p => <label key={p.id} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={resources.printer_ids!.includes(p.id)} onChange={e => change({ ...resources, printer_ids: e.target.checked ? [...resources.printer_ids!, p.id].sort((a,b) => a-b) : resources.printer_ids!.filter(id => id !== p.id) })} /><span className="break-words">{p.name}<span className="block text-xs text-bambu-gray">{p.model} {!p.active && t('orderResources.inactive')}</span></span></label>)}</div>
          </>}
        </fieldset>
        <p className="text-sm" role="status">{t('orderResources.allowed', { count: eligible.length })}: {eligible.map(p => p.name).join(', ') || t('orderResources.none')}</p>
        {(invalid || !eligible.length) && <p className="text-sm text-amber-700 dark:text-amber-400">{t('orderResources.emptyWarning')}</p>}
        <Button disabled={busy || !dirty || !!invalid || !eligible.length} onClick={() => void save()}>{t('orderResources.save')}</Button>
        {dirty && <p className="text-sm text-bambu-gray">{t('orderResources.unsaved')}</p>}
        <section className="space-y-3 border-t border-bambu-dark-tertiary pt-4">
          <h3 className="font-semibold">{t('orderResources.replan')}</h3>
          <p className="text-sm text-bambu-gray">{t('orderResources.replanHelp')}</p>
          <Button variant="outline" disabled={busy || dirty || !canReplan} onClick={() => void preview()}>{t('orderResources.preview')}</Button>
          {!canReplan && <p className="text-xs text-bambu-gray">{t('orderResources.queuePermission')}</p>}
          {proposal && <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 space-y-3">
            <p>{t('orderResources.reviewCounts', { auto: proposal.remove_auto_ids.length, printer: proposal.remove_printer_ids.length, count: proposal.count })}</p>
            <p className="text-sm">{t('orderResources.preserved', { count: proposal.preserved_printer_ids.length + proposal.preserved_auto_ids.length })}</p>
            {(proposal.preserved_printer_ids.length > 0 || proposal.preserved_auto_ids.length > 0) && <p className="text-xs text-bambu-gray">{t('orderResources.protectedHint')}</p>}
            <p className="text-sm">{t('orderResources.replaceDraft', { count: proposal.previous_draft_count })}</p>
            <ul className="space-y-1 text-sm max-h-44 overflow-auto">{proposal.rows.map(p => <li key={`${p.line_id}-${p.filename}-${p.printer_model}`} className="break-words">{p.filename} · {p.printer_model} · × {p.count}</li>)}</ul>
            <label className="flex gap-2 items-start text-sm"><input type="checkbox" className="mt-1" checked={ack} disabled={busy} onChange={e => setAck(e.target.checked)} />{t('orderResources.ack')}</label>
            <Button disabled={busy || !ack} onClick={() => void apply()}>{t('orderResources.apply')}</Button>
          </div>}
        </section>
      </>}
      {busy && <p role="status">{t('common.loading')}</p>}
      {error && <div role="alert" className="text-red-600 dark:text-red-400"><p>{error}</p>
        <Button variant="secondary" disabled={busy} onClick={() => {
          setEdited(undefined); setEditingToken(undefined); setProposal(undefined); setAck(false); setError(undefined);
          void query.refetch();
        }}>{t('orderResources.reload')}</Button></div>}
      {notice && <p role="status" className="text-bambu-green">{notice}</p>}
    </div>
  </Modal>;
}
