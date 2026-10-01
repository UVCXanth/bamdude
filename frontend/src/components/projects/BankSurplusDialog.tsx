import { useEffect, useId, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { Order } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useOrderDetail } from '../../hooks/useOrderDetail';
import { invalidateOrderViews } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { WorkshopTableScroll } from '../workshop/WorkshopPanel';
import { lineConfigLabel } from './lineConfigLabel';
import type { OrderRef } from './orderActions/orderRef';

/**
 * «Surplus to free stock» (WS-13 E6 F01): the order's overprint onto its products'
 * shelves, confirmed with the SERVER's preview — each part's `bankable` (H01) and the
 * order's `bankable_surplus` — never a difference of client counters. The POST moves
 * what the server recounts at that moment, so the dialog says the preview is the state
 * when it was read; the toast is built from what actually moved.
 *
 * ⚠️ `nothing_to_bank` is a SUCCESS — the answer to a second press — and gets a neutral
 * toast, never an error.
 */
export function BankSurplusDialog({ order, detail, onClose }: { order: OrderRef; detail?: Order; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { showToast } = useToast();
  // The detail hands its order over; from a list the full order is read.
  const read = useOrderDetail(detail ? null : order.id);
  const full = detail ?? read.data;
  const sent = useRef(false);
  const primaryId = useId();

  const bank = useMutation({
    mutationFn: () => api.bankOrderSurplus(order.id),
    onSuccess: (result) => {
      invalidateOrderViews(qc, { orderId: order.id });
      if (result.nothing_to_bank) showToast(t('stock.bank.nothing'), 'info');
      else {
        const moved = result.moved.map((m) => `${m.delta} ${m.name}`).join(', ');
        const products = [...new Set((full?.lines ?? []).map((line) => line.product_name))].join(', ');
        showToast(t('stock.bank.done', { moved, product: products }));
      }
      onClose();
    },
    onError: () => {
      sent.current = false;
    },
  });

  // A refusal leaves focus on the button that sent it — never on BODY (C08, for every dialog).
  useEffect(() => {
    if (bank.isError) document.getElementById(primaryId)?.focus();
  }, [bank.isError, bank.error, primaryId]);

  const rows = (full?.lines ?? []).flatMap((line) =>
    line.parts
      .filter((part) => part.bankable > 0)
      .map((part) => ({ key: `${line.id}:${part.part_id}`, part: part.name, line, moves: part.bankable })),
  );
  const total = full?.figures.bankable_surplus ?? 0;

  return (
    <WorkshopDialog
      onClose={onClose}
      title={t('stock.bank.dialogTitle')}
      subtitle={`${order.code} · ${order.name}`}
      size="md"
      pending={bank.isPending}
      error={bank.isError ? (bank.error as Error).message : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={bank.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            id={primaryId}
            disabled={!full || total === 0 || bank.isPending}
            onClick={() => {
              if (sent.current) return;
              sent.current = true;
              bank.mutate();
            }}
          >
            {t('stock.bank.submitCount', { count: total })}
            {bank.isPending && '…'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-white">{t('stock.bank.dialogExplain')}</p>
        {!full ? (
          read.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-red-500">
              <span>{t('stock.bank.loadFailed')}</span>
              <Button variant="secondary" size="sm" onClick={() => void read.refetch()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : (
            <div role="status" aria-busy className="h-16 rounded-lg bg-bambu-dark-tertiary/60 animate-pulse">
              <span className="sr-only">{t('common.loading')}</span>
            </div>
          )
        ) : total === 0 ? (
          <p className="text-bambu-gray">{t('stock.bank.nothingToMove')}</p>
        ) : (
          <>
            <WorkshopTableScroll label={t('stock.bank.dialogTitle')}>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-normal text-bambu-gray">{t('stock.bank.colPart')}</th>
                    <th className="px-3 py-2 text-left text-xs font-normal text-bambu-gray">{t('stock.bank.colLine')}</th>
                    <th className="px-3 py-2 text-right text-xs font-normal text-bambu-gray">{t('stock.bank.colMoves')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const config = lineConfigLabel(row.line.configuration, row.line.mode, t);
                    return (
                      <tr key={row.key} className="border-t border-bambu-dark-tertiary">
                        <td className="px-3 py-2 text-white">{row.part}</td>
                        <td className="px-3 py-2 text-bambu-gray-light">
                          {row.line.product_name}
                          {config && <small className="block text-xs text-bambu-gray">{config}</small>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-white">{row.moves}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </WorkshopTableScroll>
            <p className="text-right text-bambu-gray-light">
              {t('stock.bank.total')}: <span className="tabular-nums text-white">{total}</span>
            </p>
            <p className="text-xs text-bambu-gray">{t('stock.bank.dialogRecount')}</p>
          </>
        )}
      </div>
    </WorkshopDialog>
  );
}
