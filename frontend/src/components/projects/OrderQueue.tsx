import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Clock, Layers, ListTodo, Package } from 'lucide-react';
import { api, withStreamToken } from '../../api/client';
import type { AutoQueueItem, OrderQueuePrinting, PrintQueueItem } from '../../api/client';
import { farmPollInterval, farmStatusPollInterval } from '../../api/farmReadBudget';
import { useOrderDetail } from '../../hooks/useOrderDetail';
import { useQueueRowPicture } from '../../hooks/useQueueRowPicture';
import { formatDuration, formatETA, type TimeFormat } from '../../utils/date';

interface OrderQueueProps {
  orderId: number;
}

/**
 * What this order has on a printer right now, what waits in a printer's queue,
 * and what waits for the auto-queue's distributor.
 *
 * ⚠️ **One endpoint, both tiers** (spec workshop-order-queue). The panel used to
 * filter the farm-wide queue lists on the client: it missed the auto-queue — so
 * work the plan had just queued showed in the «In queue» tile but not here —
 * and pulled the whole farm's queue onto one order's page. `GET
 * /projects/{id}/queue` lists exactly the rows the tiles count, through the
 * same server conditions.
 *
 * Informational only, by design: no pause / cancel / reorder here. Those live
 * on the queue page, where the whole picture is, and a farm decision taken
 * from inside one order is the decision most likely to be wrong.
 *
 * The order comes from the SAME `['project', id]` cache entry the page already
 * filled — the component takes an id so it stays independent of the page's
 * render, not so it can fetch a second copy.
 */
export function OrderQueue({ orderId }: OrderQueueProps) {
  const { t } = useTranslation();

  const { data: order } = useOrderDetail(orderId);
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const { data: tiers } = useQuery({
    queryKey: ['project-queue', orderId],
    queryFn: () => api.getOrderQueue(orderId),
    // Order mutations and queue socket events re-read it; this is the safety net
    // for a dropped socket — the queue lists' own interval.
    refetchInterval: (query) => farmPollInterval(10_000, query),
  });
  const printing = tiers?.printing ?? [];
  const pending = tiers?.pending ?? [];
  const awaiting = tiers?.awaiting ?? [];
  const nothing = printing.length === 0 && pending.length === 0 && awaiting.length === 0;

  // The tiles (`['project', id]`) neither poll nor hear the queue's socket
  // events; this section does both. When ITS rows change, the order's figures
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

  // A finished order with nothing left has nothing to say here; an active one
  // answers "is anything moving?" even when the answer is no.
  if (nothing && order?.status !== 'active') return null;

  const lineName = (lineId: number | null | undefined) =>
    order?.lines.find((line) => line.id === lineId)?.product_name;

  const timeFormat: TimeFormat = settings?.time_format || 'system';

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <ListTodo className="w-5 h-5" />
          {t('orders.queue.title')}
        </h2>
        {/* No `?project=` — QueuePage reads only `view` off the URL, so the
            filter this link was copied with was never applied. */}
        <Link to="/queue" className="text-sm text-bambu-green hover:underline">
          {t('orders.queue.viewAll')}
        </Link>
      </div>

      {nothing ? (
        <p className="text-sm text-bambu-gray/70 italic">{t('orders.queue.empty')}</p>
      ) : (
        <>
          {printing.length > 0 && (
            // Container tiers, not window ones: the order view is also the workspace's
            // right pane (spec workshop-order-views, rule 12). @xl / @2xl (576 / 672px of
            // the view) are where the old window sm / lg landed on the order page itself —
            // a 1024px window with the sidebar open leaves the view ~736px; @sm / @lg
            // (384 / 512px) would fit three cards into 512px.
            <div className="grid grid-cols-1 @xl:grid-cols-2 @2xl:grid-cols-3 gap-3">
              {printing.map((print) => (
                <CurrentPrintInfoCard
                  key={print.archive_id}
                  print={print}
                  timeFormat={timeFormat}
                  lineName={lineName(print.project_line_id)}
                />
              ))}
            </div>
          )}

          {pending.length > 0 && (
            <div className="space-y-2">
              <h3 id={`order-${orderId}-queue-pending`} className="text-sm text-bambu-gray">
                {t('orders.queue.onPrinter')}
              </h3>
              <ul aria-labelledby={`order-${orderId}-queue-pending`} className="space-y-2">
                {pending.map((item) => (
                  <PendingRow key={item.id} item={item} lineName={lineName(item.project_line_id)} />
                ))}
              </ul>
            </div>
          )}

          {awaiting.length > 0 && (
            <div className="space-y-2">
              <h3 id={`order-${orderId}-queue-awaiting`} className="text-sm text-bambu-gray">
                {t('orders.queue.awaiting')}
              </h3>
              <ul aria-labelledby={`order-${orderId}-queue-awaiting`} className="space-y-2">
                {awaiting.map((item) => (
                  <AwaitingRow key={item.id} item={item} lineName={lineName(item.project_line_id)} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function LineLabel({ name }: { name: string | undefined }) {
  const { t } = useTranslation();
  if (!name) return null;
  return <p className="text-xs text-bambu-gray truncate">{t('orders.queue.line', { name })}</p>;
}

/**
 * A waiting job: what it is, where it is going, which line it answers to.
 *
 * ⚠️ `archive_thumbnail` / `library_file_thumbnail` are the server's DISK
 * paths, not URLs — they say a picture exists, and the id says where to ask
 * for it. Feeding the path straight to an `<img src>` is a broken image on
 * every row that has one.
 *
 * ⚠️ **The job's own render comes first** (m173, spec §4 / A09). A job keeps an
 * immutable copy of the bytes it prints, so it still prints — and must still
 * show itself — after its library file or archive is deleted, and neither of the
 * two URLs above can be built for a row with no ids. Its own copy also outranks
 * a surviving original, which may have been re-sliced since the job accepted its
 * bytes (A03). `source_thumbnail` says whether there is one to ask for, so
 * nothing here guesses and nothing renders a broken image.
 */
function PendingRow({ item, lineName }: { item: PrintQueueItem; lineName: string | undefined }) {
  const original =
    item.archive_id != null && item.archive_thumbnail
      ? api.getArchiveThumbnail(item.archive_id)
      : item.library_file_id != null && item.library_file_thumbnail
        ? api.getLibraryFileThumbnailUrl(item.library_file_id)
        : null;
  const thumbnail = useQueueRowPicture(item.source_thumbnail ? item.id : null, original);
  const name = item.archive_name || item.library_file_name || `#${item.id}`;

  return (
    <li className="flex items-center gap-3 rounded-lg bg-bambu-dark-secondary border border-bambu-dark-tertiary p-2">
      {thumbnail ? (
        <img src={thumbnail} alt="" className="w-10 h-10 rounded object-contain bg-bambu-dark flex-shrink-0" />
      ) : (
        <div className="w-10 h-10 rounded bg-bambu-dark flex items-center justify-center flex-shrink-0">
          <Package className="w-4 h-4 text-bambu-gray" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white truncate">{name}</p>
        <LineLabel name={lineName} />
      </div>
      {item.printer_name && (
        <span className="text-xs text-bambu-gray flex-shrink-0">{item.printer_name}</span>
      )}
    </li>
  );
}

/**
 * A job the auto-queue's distributor has not handed to a printer yet: what it
 * is, which printers it may go to, and — as the queue page shows it — why it is
 * still waiting. The original's picture only: an auto-queue row has no
 * `source-thumbnail` route of its own.
 */
function AwaitingRow({ item, lineName }: { item: AutoQueueItem; lineName: string | undefined }) {
  const { t } = useTranslation();
  const thumbnail =
    item.archive_id != null && item.archive_thumbnail
      ? api.getArchiveThumbnail(item.archive_id)
      : item.library_file_id != null && item.library_file_thumbnail
        ? api.getLibraryFileThumbnailUrl(item.library_file_id)
        : null;
  const name = item.archive_name || item.library_file_name || `#${item.id}`;
  const target =
    [item.target_model, item.target_location?.name].filter(Boolean).join(' · ') || t('orders.queue.anyPrinter');

  return (
    <li className="flex items-center gap-3 rounded-lg bg-bambu-dark-secondary border border-bambu-dark-tertiary p-2">
      {thumbnail ? (
        <img src={thumbnail} alt="" className="w-10 h-10 rounded object-contain bg-bambu-dark flex-shrink-0" />
      ) : (
        <div className="w-10 h-10 rounded bg-bambu-dark flex items-center justify-center flex-shrink-0">
          <Package className="w-4 h-4 text-bambu-gray" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white truncate">{name}</p>
        <LineLabel name={lineName} />
        <p className="text-xs text-bambu-gray truncate">{t('orders.queue.target', { target })}</p>
        {item.waiting_reason && (
          <p className="text-xs text-yellow-700 dark:text-yellow-400 truncate">{item.waiting_reason}</p>
        )}
      </div>
    </li>
  );
}

interface CurrentPrintInfoCardProps {
  print: OrderQueuePrinting;
  timeFormat: TimeFormat;
  lineName: string | undefined;
}

/**
 * Info-only current-print card, moved here from the old project page. Mirrors
 * the layout of QueueCard's live-print block (thumbnail + name + progress +
 * ETA/layer) but renders nothing interactive — this panel exists solely to
 * surface which of the order's jobs are live on which printer. The progress
 * bar uses the same green / amber (paused) fill as the printers and queue
 * pages.
 */
function CurrentPrintInfoCard({ print, timeFormat, lineName }: CurrentPrintInfoCardProps) {
  const { t } = useTranslation();
  const { data: status } = useQuery({
    queryKey: ['printerStatus', print.printer_id],
    queryFn: ({ signal }) => api.getPrinterStatus(print.printer_id as number, signal),
    enabled: print.printer_id != null,
    refetchInterval: query => farmStatusPollInterval(5000, query),
  });

  const isLive = status?.state === 'RUNNING' || status?.state === 'PAUSE';
  // The ORDER's print names the card. Between dispatch and the real start
  // (upload, preheat) the printer still reports its previous job — possibly
  // another order's — so its name never stands in for ours, and its cover shows
  // only while it is actually running.
  const name = print.name;
  const thumbnail = isLive ? status?.cover_url : undefined;
  const progress = status?.progress ?? 0;

  return (
    <div className="p-3 rounded-lg bg-bambu-dark-secondary border border-bambu-dark-tertiary">
      <div className="flex items-start gap-3">
        {thumbnail ? (
          <img
            src={withStreamToken(thumbnail)}
            alt=""
            className="w-20 h-20 rounded-lg object-contain flex-shrink-0 bg-bambu-dark-tertiary"
          />
        ) : (
          <div className="w-20 h-20 rounded-lg bg-bambu-dark-tertiary flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-1">
            <p className="text-sm text-bambu-gray">{t('queueCard.currentPrint')}</p>
            {print.printer_name && print.printer_id != null && (
              <Link
                to={`/#printer-${print.printer_id}`}
                className="text-xs text-bambu-gray/70 hover:text-bambu-green transition-colors"
                title={t('queueCard.goToPrinter')}
              >
                · {print.printer_name}
              </Link>
            )}
          </div>
          <p className="text-sm text-white truncate mb-1">{name}</p>
          <LineLabel name={lineName} />
          {isLive ? (
            <>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 bg-bambu-dark-tertiary rounded-full h-2 overflow-hidden">
                  <div
                    className={`${status?.state === 'PAUSE' ? 'bg-status-warning' : 'bg-bambu-green'} h-2 rounded-full transition-all`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="text-sm text-white font-medium flex-shrink-0">{Math.round(progress)}%</span>
              </div>
              <div className="flex items-center gap-3 mt-2 text-xs text-bambu-gray">
                {status?.remaining_time != null && status.remaining_time > 0 && (
                  <>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDuration(status.remaining_time * 60)}
                    </span>
                    <span className="text-bambu-green font-medium">
                      {t('orders.queue.eta')} {formatETA(status.remaining_time, timeFormat, t)}
                    </span>
                  </>
                )}
                {status.layer_num != null && status.total_layers != null && status.total_layers > 0 && (
                  <span className="flex items-center gap-1">
                    <Layers className="w-3 h-3" />
                    {status.layer_num}/{status.total_layers}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 bg-bambu-dark-tertiary rounded-full h-2">
                <div className="bg-bambu-green h-2 rounded-full" style={{ width: '0%' }} />
              </div>
              <span className="text-sm text-white font-medium flex-shrink-0">0%</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
