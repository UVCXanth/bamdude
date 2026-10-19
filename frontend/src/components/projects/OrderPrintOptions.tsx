import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Settings } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderPrintOptionsResponse } from '../../api/client';
import { Button } from '../Button';
import { PrintOptionsPanel } from '../PrintModal/PrintOptions';
import type { PrintOptions } from '../PrintModal/types';

type Overrides = OrderPrintOptionsResponse['overrides'];
const CALIBRATIONS = ['bed_levelling', 'flow_cali', 'nozzle_offset_cali'] as const;

/** Persistent order intent, copied by the server when either plan queue button
 * creates new jobs. Unsaved edits block enqueue; refetches keep the local draft. */
export function OrderPrintOptions({ orderId, canEdit, busy, onBlocked }: {
  orderId: number; canEdit: boolean; busy: boolean; onBlocked: (blocked: boolean) => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Overrides | null>(null);
  const queryKey = ['order-print-options', orderId];
  const query = useQuery({ queryKey, queryFn: () => api.getOrderPrintOptions(orderId) });
  const overrides = draft ?? query.data?.overrides ?? {};
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(query.data?.overrides ?? {});
  const save = useMutation({
    mutationFn: (values: Overrides) => api.setOrderPrintOptions(orderId, values),
    onSuccess: (data) => {
      client.setQueryData(queryKey, data);
      setDraft(null);
    },
  });
  useEffect(() => {
    onBlocked(dirty || save.isPending);
    return () => onBlocked(false);
  }, [dirty, save.isPending, onBlocked]);
  const models = query.data?.models ?? [];
  const current = models.find((m) => m.model === selected) ?? models[0];
  const editable = canEdit && !busy && !save.isPending;
  const options = current ? overrides[current.model] ?? current.inherited : null;
  const setOptions = (next: PrintOptions) => {
    if (editable && current) setDraft({ ...overrides, [current.model]: next });
  };
  const summary = (model: OrderPrintOptionsResponse['models'][number], values: PrintOptions) => [
    ...CALIBRATIONS.filter((key) => model.capabilities.supported[key]).map((key) =>
      `${t(`orderPrintOptions.${key}`)}: ${t(`printModal.calibrationMode_${values[key]}`)}`,
    ),
    `${t('printModal.timelapse')}: ${t(`printModal.calibrationMode_${values.timelapse ? 'on' : 'off'}`)}`,
  ].join(' · ');

  return (
    <div className="rounded-xl border border-bambu-dark-tertiary p-3" data-testid="order-print-options">
      <button type="button" className="flex items-center gap-2 w-full text-sm text-white"
        aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <Settings className="w-4 h-4 text-bambu-gray" />
        {t('orderPrintOptions.title')}
        <ChevronDown className={`w-4 h-4 ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      <p className="text-xs text-bambu-gray mt-2">{t('orderPrintOptions.scope')}</p>
      <div className="mt-2 grid sm:grid-cols-2 gap-x-4 gap-y-2 text-xs text-bambu-gray">
        {models.map((m) => (
          <div key={m.model}><strong className="text-white">{m.model}</strong> · {t(
            overrides[m.model] ? 'orderPrintOptions.custom' : 'orderPrintOptions.inherit',
          )}<p className="mt-0.5">{summary(m, overrides[m.model] ?? m.inherited)}</p></div>
        ))}
      </div>
      {dirty && <p className="text-xs text-amber-700 dark:text-amber-400 mt-2" role="status">{t('orderPrintOptions.unsaved')}</p>}
      {expanded && (
        <div className="mt-3 space-y-3">
          {query.isPending && <p className="text-sm text-bambu-gray">{t('common.loading')}</p>}
          {query.isError && <div role="alert" className="text-sm text-red-600 dark:text-red-400">
            <p>{query.error.message}</p>
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>{t('orderPrintOptions.retry')}</Button>
          </div>}
          {!query.isPending && !query.isError && models.length === 0 && (
            <p className="text-xs text-bambu-gray">{t('orderPrintOptions.noModels')}</p>
          )}
          {models.length > 0 && <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('orderPrintOptions.models')}>
            {models.map((m) => <button key={m.model} type="button" role="tab" aria-selected={current?.model === m.model}
              onClick={() => setSelected(m.model)} className={`rounded-lg px-3 py-1.5 text-sm ${current?.model === m.model
                ? 'bg-bambu-green text-white' : 'bg-bambu-dark-tertiary text-bambu-gray hover:text-white'}`}>
              {m.model}
            </button>)}
          </div>}
          {current && options && <div role="tabpanel" aria-label={current.model}>
            <label className="flex gap-2 items-center text-sm text-white">
              <input type="checkbox" checked={!!overrides[current.model]} disabled={!editable || !current.capabilities.known}
                onChange={(event) => {
                  if (event.target.checked) setOptions({ ...current.inherited });
                  else {
                    const next = { ...overrides };
                    delete next[current.model];
                    setDraft(next);
                  }
                }} />
              {t('orderPrintOptions.override')}
            </label>
            {!current.capabilities.known && <p className="text-xs text-amber-700 dark:text-amber-400 mt-2">{t('orderPrintOptions.unknown')}</p>}
            <p className="text-xs text-bambu-gray my-2" data-testid="order-options-summary">
              {summary(current, options)}
            </p>
            {!!overrides[current.model] && <fieldset disabled={!editable} className={!editable ? 'opacity-60' : ''}>
              <PrintOptionsPanel options={options} onChange={setOptions} defaultExpanded
                autoCaps={current.capabilities.auto} supportedOptions={current.capabilities.supported}
                showDualNozzleOptions={current.capabilities.supported.nozzle_offset_cali} />
            </fieldset>}
          </div>}
          {save.isError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{save.error.message}</p>}
          {canEdit && <div className="flex gap-2">
            <Button size="sm" disabled={!dirty || !editable} onClick={() => save.mutate(overrides)}>
              {save.isPending ? t('common.loading') : t('orderPrintOptions.save')}
            </Button>
            <Button size="sm" variant="outline" disabled={!dirty || !editable} onClick={() => { setDraft(null); save.reset(); }}>
              {t('common.cancel')}
            </Button>
          </div>}
        </div>
      )}
    </div>
  );
}
