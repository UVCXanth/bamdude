import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Ban,
  CheckCircle,
  CircleDot,
  Flag,
  History,
  Image,
  Link,
  ListMinus,
  ListPlus,
  ListTodo,
  PackagePlus,
  Paperclip,
  Pencil,
  Plus,
  Printer,
  ShoppingCart,
  Shuffle,
  TriangleAlert,
  Unlink,
  UserRound,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../../api/client';
import { formatDateTime, type DateFormat, type TimeFormat } from '../../utils/date';
import { LoadingBlock } from '../LoadingBlock';
import { journalText } from './orderJournal';

/** One icon per order journal code (spec workshop-order-stage, rule 35). */
const JOURNAL_ICONS: Record<string, LucideIcon> = {
  order_created: Plus,
  status_changed: CircleDot,
  fields_changed: Pencil,
  responsible_changed: UserRound,
  stage_changed: Flag,
  line_added: ListPlus,
  line_changed: Pencil,
  line_removed: ListMinus,
  prints_filed: Link,
  prints_unfiled: Unlink,
  defects_recorded: TriangleAlert,
  queue_items_filed: ListTodo,
  plan_enqueued: ListTodo,
  line_rebalanced: Shuffle,
  surplus_banked: PackagePlus,
  procurement_updated: ShoppingCart,
  attachment_added: Paperclip,
  attachment_removed: Paperclip,
  cover_changed: Image,
};

/** The whole feed arrives at once; the card shows a readable slice until asked. */
const TIMELINE_COLLAPSED = 10;

interface OrderTimelineProps {
  orderId: number;
}

/**
 * What has happened to this order, newest first.
 *
 * ⚠️ **The label is translated from `event_type`, never taken from the wire.**
 * The server's `title` is English and exists for API callers; it is the
 * fallback for an event type this build has no word for yet, so a new backend
 * event degrades to readable English instead of a blank row.
 */
export function OrderTimeline({ orderId }: OrderTimelineProps) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const { data: timeline, isLoading } = useQuery({
    queryKey: ['project-timeline', orderId],
    queryFn: () => api.getProjectTimeline(orderId),
  });

  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const timeFormat: TimeFormat = settings?.time_format || 'system';
  const dateFormat = (settings?.date_format || 'system') as DateFormat;

  const when = (timestamp: string) =>
    formatDateTime(timestamp, timeFormat, dateFormat, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-white flex items-center gap-2">
        <History className="w-5 h-5" />
        {t('orders.timeline.title')}
      </h2>

      {isLoading ? (
        <LoadingBlock label={t('common.loading')} className="py-4 text-bambu-gray" />
      ) : timeline && timeline.length > 0 ? (
        <div className="space-y-3">
          {(expanded ? timeline : timeline.slice(0, TIMELINE_COLLAPSED)).map((event, index) => (
            <div key={`${event.timestamp}-${index}`} className="flex gap-3">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  event.event_type === 'print_completed'
                    ? 'bg-status-ok/20 text-status-ok'
                    : event.event_type === 'print_failed'
                      ? 'bg-status-error/20 text-status-error'
                      : event.event_type === 'print_cancelled'
                        ? 'bg-bambu-dark-tertiary text-status-error/70'
                        : event.event_type === 'print_started'
                          ? 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-400'
                          : 'bg-bambu-dark-tertiary text-bambu-gray'
                }`}
              >
                {event.event_type === 'print_completed' && <CheckCircle className="w-4 h-4" />}
                {event.event_type === 'print_failed' && <XCircle className="w-4 h-4" />}
                {event.event_type === 'print_cancelled' && <Ban className="w-4 h-4" />}
                {event.event_type === 'print_started' && <Printer className="w-4 h-4" />}
                {event.event_type === 'queued' && <ListTodo className="w-4 h-4" />}
                {event.event_type === 'auto_queued' && <Shuffle className="w-4 h-4" />}
                {event.event_type === 'project_created' && <Plus className="w-4 h-4" />}
                {(() => {
                  const Icon = JOURNAL_ICONS[event.event_type];
                  return Icon ? <Icon className="w-4 h-4" /> : null;
                })()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white">
                  {journalText(event, t) ??
                    (i18n.exists(`orders.timeline.events.${event.event_type}`)
                      ? t(`orders.timeline.events.${event.event_type}`)
                      : event.title)}
                </p>
                {event.description && <p className="text-xs text-bambu-gray truncate">{event.description}</p>}
                <p className="text-xs text-bambu-gray/70">
                  {when(event.timestamp)}
                  {/* Who did it — the journal's name snapshot (spec workshop-order-stage, rule 35). */}
                  {typeof event.metadata?.user_name === 'string' && <span> · {event.metadata.user_name}</span>}
                </p>
              </div>
            </div>
          ))}

          {timeline.length > TIMELINE_COLLAPSED && (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              className="text-xs text-bambu-green hover:underline"
            >
              {expanded
                ? t('orders.timeline.showLess')
                : t('orders.timeline.showMore', { count: timeline.length - TIMELINE_COLLAPSED })}
            </button>
          )}
        </div>
      ) : (
        <p className="text-sm text-bambu-gray/70 italic">{t('orders.timeline.empty')}</p>
      )}
    </section>
  );
}
