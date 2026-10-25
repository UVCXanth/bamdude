import { Printer, SlidersHorizontal } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type OrderPrinterResourceState } from '../../api/client';
import { Button } from '../Button';
import { useAuth } from '../../contexts/AuthContext';

export interface OrderResourceDoor { orderId: number; onChanged: () => void }

function resourceSummary(data: OrderPrinterResourceState, fallback: (id: number) => string) {
  const { models, printer_ids } = data.resources;
  return [models?.join(', '), printer_ids?.map(id => data.printers.find(p => p.id === id)?.name ?? fallback(id)).join(', ')].filter(Boolean).join(' · ');
}

export function OrderPrinterResources({ orderId, editable, onConfigure }: {
  orderId: number; editable: boolean; onConfigure: () => void;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const query = useQuery({ queryKey: ['order-printer-resources', orderId], queryFn: () => api.getOrderPrinterResources(orderId),
    enabled: hasPermission('printers:read') });
  if (!hasPermission('printers:read')) return null;
  const summary = query.data && resourceSummary(query.data, id => t('orderResources.printerId', { id }));
  return <section className="rounded-xl border border-bambu-green/40 bg-bambu-green/5 p-4" aria-label={t('orderResources.title')}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="flex items-center gap-2 font-semibold text-white"><Printer className="h-5 w-5 text-bambu-green" />{t('orderResources.title')}</h3>
        <p className="mt-1 break-words text-sm text-white">{query.isPending ? t('common.loading') : query.isError ? t('orderResources.loadFailed') : summary || t('orderResources.wholeFarm')}</p>
        <p className="mt-1 text-xs text-bambu-gray">{t('orderResources.summaryHint')}</p>
      </div>
      <Button onClick={onConfigure} disabled={!editable || query.isPending || query.isError}>
        <SlidersHorizontal className="mr-2 h-4 w-4" />{t('orderResources.configure')}
      </Button>
    </div>
    {query.isError && <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>{t('common.retry')}</Button>}
  </section>;
}
