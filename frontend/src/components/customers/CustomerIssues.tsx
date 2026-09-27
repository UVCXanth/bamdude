import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, Pencil, X } from 'lucide-react';
import { api, WAYBILL_MAX } from '../../api/client';
import type { StockIssueRow } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useCustomerIssues } from '../../hooks/useFulfilment';
import { PaginationBar } from '../PaginationBar';
import { formatDateTime } from '../../utils/date';
import type { DateFormat, TimeFormat } from '../../utils/date';

const PER_PAGE = 20;
const ICON_BTN = 'p-1 rounded text-bambu-gray hover:text-white hover:bg-bambu-dark transition-colors';

/**
 * «Видачі» on a customer's page (spec workshop-order-issue, rules 22 and 30): the
 * customer's issues, newest first, paged on the server — from its orders and
 * without one. The waybill is written in the row afterwards (rule 21); nothing
 * else about an issue changes.
 */
export function CustomerIssues({ customerId, canEdit }: { customerId: number; canEdit: boolean }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(PER_PAGE);
  const { data, isLoading } = useCustomerIssues(customerId, page, perPage);

  if (isLoading) return null;
  const items = data?.items ?? [];

  return (
    <section className="space-y-3" data-testid="customer-issues">
      <h2 className="text-lg font-medium text-white">{t('customers.issues.title')}</h2>
      {items.length === 0 ? (
        <p className="text-bambu-gray text-sm">{t('customers.issues.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-bambu-gray">
                <th className="font-normal p-2">{t('customers.issues.date')}</th>
                <th className="font-normal p-2">{t('customers.issues.order')}</th>
                <th className="font-normal p-2 text-right">{t('customers.issues.units')}</th>
                <th className="font-normal p-2">{t('customers.issues.recipient')}</th>
                <th className="font-normal p-2">{t('customers.issues.method')}</th>
                <th className="font-normal p-2">{t('customers.issues.waybill')}</th>
                <th className="font-normal p-2">{t('customers.issues.by')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((issue) => (
                <IssueRow key={issue.id} issue={issue} canEdit={canEdit} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <PaginationBar
          page={page}
          totalPages={data.meta.last_page}
          perPage={perPage}
          total={data.meta.total}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
          items={t('customers.issues.items')}
          variant="bare"
        />
      )}
    </section>
  );
}

function IssueRow({ issue, canEdit }: { issue: StockIssueRow; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  // The server sends naive UTC; the app's own formatter reads it as such and follows the
  // date and time settings (final review I3).
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const timeFormat = (settings?.time_format ?? 'system') as TimeFormat;
  const dateFormat = (settings?.date_format ?? 'system') as DateFormat;

  const save = useMutation({
    mutationFn: (waybill: string) => api.updateStockIssue(issue.id, { waybill: waybill.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer-issues'] });
      setEditing(null);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  return (
    <tr className="border-t border-bambu-dark-tertiary text-white" data-testid={`issue-${issue.id}`}>
      <td className="p-2 whitespace-nowrap text-bambu-gray">{formatDateTime(issue.created_at, timeFormat, dateFormat)}</td>
      <td className="p-2">
        {issue.project_id != null && issue.project_code ? (
          <Link to={`/projects/${issue.project_id}`} className="hover:underline">
            {issue.project_code}
          </Link>
        ) : (
          <span className="text-bambu-gray">{t('customers.issues.noOrder')}</span>
        )}
      </td>
      <td className="p-2 text-right tabular-nums">{issue.units}</td>
      <td className="p-2">
        {issue.recipient_name ?? ''}
        {issue.recipient_phone && <span className="text-bambu-gray"> · {issue.recipient_phone}</span>}
      </td>
      <td className="p-2">{issue.delivery_method ?? ''}</td>
      <td className="p-2">
        {editing != null ? (
          <span className="flex items-center gap-1">
            <input
              value={editing}
              maxLength={WAYBILL_MAX}
              onChange={(e) => setEditing(e.target.value)}
              aria-label={t('customers.issues.waybill')}
              className="w-44 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white"
            />
            <button
              type="button"
              onClick={() => save.mutate(editing)}
              disabled={save.isPending}
              aria-label={t('common.save')}
              title={t('common.save')}
              className={ICON_BTN}
            >
              <Check className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              aria-label={t('common.cancel')}
              title={t('common.cancel')}
              className={ICON_BTN}
            >
              <X className="w-4 h-4" />
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <span className="tabular-nums">{issue.waybill ?? ''}</span>
            {canEdit && (
              <button
                type="button"
                onClick={() => setEditing(issue.waybill ?? '')}
                aria-label={t('customers.issues.editWaybill')}
                title={t('customers.issues.editWaybill')}
                className={ICON_BTN}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
          </span>
        )}
      </td>
      <td className="p-2 text-bambu-gray">{issue.created_by_name ?? ''}</td>
    </tr>
  );
}
