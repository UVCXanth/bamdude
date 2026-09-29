import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Clock, ExternalLink, Play } from 'lucide-react';
import { api } from '../../api/client';
import type { AutoQueueItem, OrderQueuePrinting, PrintQueueItem } from '../../api/client';
import { farmPollInterval, farmStatusPollInterval } from '../../api/farmReadBudget';
import { useOrderDetail } from '../../hooks/useOrderDetail';
import { formatDuration } from '../../utils/date';
import { Button } from '../Button';
import { WorkshopPanel } from '../workshop/WorkshopPanel';

interface OrderQueueProps {
  orderId: number;
  headingLevel?: 2 | 3;
}

/**
 * «Queue» — the order page's side panel (WS-13 E3 G04): what this order has on a
 * printer right now, what waits in a printer's queue, and what waits for the
 * auto-queue's distributor, one compact row each.
 *
 * ⚠️ **One endpoint, both tiers** (spec workshop-order-queue): `GET
 * /projects/{id}/queue` lists exactly the rows the order's tiles count, through
 * the same server conditions — never the farm-wide lists filtered here.
 *
 * ⚠️ **An absent answer is not an empty queue** (R02): «nothing queued» is said
 * only by a successful answer with three empty tiers; a cold read waits and a
 * failed one offers a retry. The panel is always there, a closed order's too.
 *
 * Informational only, by design: no pause / cancel / reorder here. Those live
 * on the queue page — the link goes there with no filter, because it reads none
 * but its view — where the whole picture is.
 */
export function OrderQueue({ orderId, headingLevel = 2 }: OrderQueueProps) {
  const { t } = useTranslation();

  const { data: order } = useOrderDetail(orderId);
  const {
    data: tiers,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['project-queue', orderId],
    queryFn: () => api.getOrderQueue(orderId),
    // Order mutations and queue socket events re-read it; this is the safety net
    // for a dropped socket — the queue lists' own interval.
    refetchInterval: (query) => farmPollInterval(10_000, query),
  });
  const printing = tiers?.printing ?? [];
  const pending = tiers?.pending ?? [];
  const awaiting = tiers?.awaiting ?? [];

  // The tiles (`['project', id]`) neither poll nor hear the queue's socket
  // events; this panel does both. When ITS rows change, the order's figures
  // are re-read with them, so the two never tell different stories for long.
  // The first answer is not a change — the page has just read the order.
  const queryClient = useQueryClient();
  const signature = tiers
    ? [printing.map((p) => p.archive_id), pending.map((i) => i.id), awaiting.map((i) => i.id)].map((ids) => ids.join(',')).join('|')
    : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (signature == null) return;
    if (seen.current != null && seen.current !== signature) {
      queryClient.invalidateQueries({ queryKey: ['project', orderId], exact: true });
    }
    seen.current = signature;
  }, [signature, orderId, queryClient]);

  const lineName = (lineId: number | null | undefined) =>
    order?.lines.find((line) => line.id === lineId)?.product_name;

  const body = () => {
    if (!tiers) {
      return isError ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-red-400">
          <span>{t('orders.queue.error')}</span>
          <Button size="sm" variant="secondary" onClick={() => refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-bambu-gray">{t('common.loading')}</p>
      );
    }
    if (printing.length === 0 && pending.length === 0 && awaiting.length === 0) {
      return <p className="text-sm text-bambu-gray">{t('orders.queue.empty')}</p>;
    }
    return (
      <div className="text-[13px]">
        {isError && (
          <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-amber-400">
            {t('orders.detail.refreshFailed')}
            <button type="button" onClick={() => refetch()} className="text-bambu-green hover:underline">
              {t('common.retry')}
            </button>
          </p>
        )}
        {printing.length > 0 && (
          <ul aria-label={t('orders.queue.printing')}>
            {printing.map((print) => (
              <PrintingRow key={print.archive_id} print={print} lineName={lineName(print.project_line_id)} />
            ))}
          </ul>
        )}
        {pending.length > 0 && (
          <ul aria-label={t('orders.queue.onPrinter')}>
            {pending.map((item) => (
              <PendingRow key={item.id} item={item} lineName={lineName(item.project_line_id)} />
            ))}
          </ul>
        )}
        {awaiting.length > 0 && (
          <>
            <ul aria-label={t('orders.queue.awaiting')}>
              {awaiting.map((item) => (
                <AwaitingRow key={item.id} item={item} lineName={lineName(item.project_line_id)} />
              ))}
            </ul>
            <p className="mt-2 text-xs leading-[18px] text-bambu-gray">{t('orders.queue.autoHint')}</p>
          </>
        )}
      </div>
    );
  };

  return (
    <WorkshopPanel
      data-testid="order-queue-panel"
      title={t('orders.queue.title')}
      headingLevel={headingLevel}
      actions={
        <Link to="/queue" className="inline-flex items-center gap-1 text-xs text-bambu-gray hover:text-white">
          {t('orders.queue.viewAll')}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </Link>
      }
    >
      {body()}
    </WorkshopPanel>
  );
}

const ROW = 'border-b border-bambu-dark-tertiary py-2.5 last:border-b-0';

/** The row's second line — each part its own element, so a reader (and a test) finds it by itself. */
function Sub({ parts }: { parts: (string | null | undefined)[] }) {
  const shown = parts.filter((part): part is string => Boolean(part));
  if (shown.length === 0) return null;
  return (
    <small className="mt-0.5 block truncate text-xs text-bambu-gray">
      {shown.map((part, index) => (
        <span key={index}>
          {index > 0 && ' · '}
          <span>{part}</span>
        </span>
      ))}
    </small>
  );
}

/**
 * A print on a printer now: the printer, the progress and time left while it
 * runs, then what it is. The ORDER's print names the row — between dispatch and
 * the real start the printer still reports its previous job, possibly another
 * order's. The status is the printers' own `['printerStatus', id]`, which the
 * client batches into one `/printers/status/batch` read per turn.
 */
function PrintingRow({ print, lineName }: { print: OrderQueuePrinting; lineName: string | undefined }) {
  const { t } = useTranslation();
  const { data: status } = useQuery({
    queryKey: ['printerStatus', print.printer_id],
    queryFn: ({ signal }) => api.getPrinterStatus(print.printer_id as number, signal),
    enabled: print.printer_id != null,
    refetchInterval: (query) => farmStatusPollInterval(5000, query),
  });
  const isLive = status?.state === 'RUNNING' || status?.state === 'PAUSE';
  const progress = isLive ? status?.progress ?? 0 : 0;
  const left = isLive && status?.remaining_time != null && status.remaining_time > 0 ? formatDuration(status.remaining_time * 60) : null;

  return (
    <li className={ROW}>
      <div className="flex items-center justify-between gap-2">
        <b className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-white">
          <Play className="h-3.5 w-3.5 shrink-0 text-bambu-green" aria-hidden />
          {print.printer_id != null && print.printer_name ? (
            <Link to={`/#printer-${print.printer_id}`} className="truncate hover:text-bambu-green" title={t('queueCard.goToPrinter')}>
              {print.printer_name}
            </Link>
          ) : (
            <span className="truncate">{print.printer_name}</span>
          )}
        </b>
        {isLive && (
          <small className="shrink-0 text-xs text-bambu-gray tabular-nums">
            {Math.round(progress)}%{left && ` · ${t('orders.queue.left', { time: left })}`}
          </small>
        )}
      </div>
      <Sub parts={[print.name, lineName && t('orders.queue.line', { name: lineName })]} />
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-bambu-dark-tertiary">
        <div
          className={`h-full rounded-full ${status?.state === 'PAUSE' ? 'bg-status-warning' : 'bg-bambu-green'}`}
          style={{ width: `${progress}%` }}
        />
      </div>
    </li>
  );
}

/** A job in a printer's queue: the printer, the estimated time, then what it is. */
function PendingRow({ item, lineName }: { item: PrintQueueItem; lineName: string | undefined }) {
  const { t } = useTranslation();
  const name = item.archive_name || item.library_file_name || `#${item.id}`;
  return (
    <li className={ROW}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-white">
          <Clock className="h-3.5 w-3.5 shrink-0 text-bambu-gray" aria-hidden />
          <span className="truncate">{item.printer_name}</span>
        </span>
        {item.print_time_seconds != null && item.print_time_seconds > 0 && (
          <small className="shrink-0 text-xs text-bambu-gray tabular-nums">{formatDuration(item.print_time_seconds)}</small>
        )}
      </div>
      <Sub
        parts={[
          name,
          item.plate_id != null ? t('orders.queue.plate', { n: item.plate_id }) : null,
          lineName && t('orders.queue.line', { name: lineName }),
        ]}
      />
    </li>
  );
}

/**
 * A job the auto-queue's distributor has not handed to a printer yet: where it
 * may go, its time, what it is — and, as the queue page shows it, why it is
 * still waiting.
 */
function AwaitingRow({ item, lineName }: { item: AutoQueueItem; lineName: string | undefined }) {
  const { t } = useTranslation();
  const name = item.archive_name || item.library_file_name || `#${item.id}`;
  const target =
    [item.target_model, item.target_location?.name].filter(Boolean).join(' · ') || t('orders.queue.anyPrinter');
  return (
    <li className={ROW}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-white">
          <Clock className="h-3.5 w-3.5 shrink-0 text-bambu-gray" aria-hidden />
          <span className="truncate">{t('orders.queue.target', { target })}</span>
        </span>
        {item.print_time_seconds != null && item.print_time_seconds > 0 && (
          <small className="shrink-0 text-xs text-bambu-gray tabular-nums">{formatDuration(item.print_time_seconds)}</small>
        )}
      </div>
      <Sub
        parts={[
          name,
          item.plate_id != null ? t('orders.queue.plate', { n: item.plate_id }) : null,
          lineName && t('orders.queue.line', { name: lineName }),
        ]}
      />
      {item.waiting_reason && <small className="mt-0.5 block text-xs text-amber-400">{item.waiting_reason}</small>}
    </li>
  );
}
