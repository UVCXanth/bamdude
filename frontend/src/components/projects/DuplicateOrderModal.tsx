import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { WorkshopField, WorkshopFormGrid } from '../workshop/WorkshopFormGrid';
import { invalidateOrderViews } from '../../utils/queryInvalidation';
import { formatCalendarDate } from '../../utils/date';
import { isPastDueDate } from '../../utils/orderDates';
import type { OrderRef } from './orderActions/orderRef';

/** `projects.name` is `String(255)`; the server refuses a longer explicit name (E6 G02). */
const NAME_MAX = 255;

/** «<base> (copy)» within the column: the original's name gives way, the suffix never (R05). */
function copyName(original: string, suffix: string): string {
  const tail = ` ${suffix}`;
  return `${original.slice(0, NAME_MAX - tail.length).trimEnd()}${tail}`;
}

/**
 * «Duplicate order» (WS-13 E6 §D) — the only way to copy an order: a named copy, never
 * a one-click mutation from a list.
 *
 * The dialog spells the split out as the server copies it — what comes across and
 * what stays with the original — because «duplicate» does not answer it. A copy of a
 * closed order becomes active with the original's deadline, so a deadline already
 * past is said whatever the original's status (R07).
 */
export function DuplicateOrderModal({ order, onClose }: { order: OrderRef; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const formId = useId();
  const nameId = useId();
  // The cursor starts in the copy's name, as the mockup's dialog does; the Modal focuses its
  // panel in its own (child) effect, and this one runs after it.
  useEffect(() => {
    document.getElementById(nameId)?.focus();
  }, [nameId]);

  // The prefill is a value, and `maxLength` does not cut an assigned value — it is
  // made to fit here (R05).
  const [name, setName] = useState(() => copyName(order.name, t('orders.duplicate.copySuffix')));
  // A second press in the same tick sees `isPending` still false; a refusal re-arms.
  const sent = useRef(false);

  const duplicate = useMutation({
    mutationFn: () => api.duplicateOrder(order.id, name.trim()),
    onSuccess: (created) => {
      invalidateOrderViews(queryClient, { orderId: created.id });
      showToast(t('orders.toast.duplicated'));
      onClose();
      navigate(`/projects/${created.id}`);
    },
    onError: () => {
      sent.current = false;
    },
  });

  // A refusal leaves focus on the button that sent it — never on BODY (C08, for every dialog).
  const submitId = `${formId}-submit`;
  useEffect(() => {
    if (duplicate.isError) document.getElementById(submitId)?.focus();
  }, [duplicate.isError, duplicate.error, submitId]);

  const canSubmit = name.trim() !== '' && !duplicate.isPending;
  const pastDue = isPastDueDate(order.due_date);

  return (
    <WorkshopDialog
      onClose={onClose}
      title={t('orders.duplicate.title')}
      subtitle={`${order.code} · ${order.name}`}
      size="md"
      pending={duplicate.isPending}
      error={duplicate.isError ? (duplicate.error as Error).message || t('orders.duplicate.failed') : undefined}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={duplicate.isPending}>
            {t('common.cancel')}
          </Button>
          <Button id={submitId} type="submit" form={formId} disabled={!canSubmit}>
            {duplicate.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('orders.duplicate.submit')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit || sent.current) return;
          sent.current = true;
          duplicate.mutate();
        }}
      >
        <WorkshopFormGrid>
          <WorkshopField label={t('orders.duplicate.nameLabel')} htmlFor={nameId} full>
            <input
              id={nameId}
              type="text"
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              disabled={duplicate.isPending}
              className="w-full px-3 py-2 rounded-lg bg-bambu-dark border border-bambu-dark-tertiary text-white placeholder:text-bambu-gray focus:outline-none focus:border-bambu-green"
            />
          </WorkshopField>
        </WorkshopFormGrid>
        <p className="text-sm text-bambu-gray">
          {t('orders.duplicate.copies')} {t('orders.duplicate.excludes')}
        </p>
        {pastDue && order.due_date && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
            {t('orders.duplicate.pastDue', {
              date: formatCalendarDate(order.due_date, { day: 'numeric', month: 'short' }, settings?.date_format),
            })}
          </p>
        )}
      </form>
    </WorkshopDialog>
  );
}
