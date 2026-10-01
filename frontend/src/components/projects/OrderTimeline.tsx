import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ban, CheckCircle, CircleDot, ListTodo, Plus, Printer, Shuffle, XCircle, type LucideIcon } from 'lucide-react';
import { api } from '../../api/client';
import { formatDateTime, type DateFormat, type TimeFormat } from '../../utils/date';
import { Button } from '../Button';
import { LoadingBlock } from '../LoadingBlock';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { WorkshopPanel } from '../workshop/WorkshopPanel';
import { journalText } from './orderJournal';
import { JOURNAL_ICONS } from './orderJournalIcons';

/** The print and queue events the timeline merges with the journal (not journal kinds). */
const EVENT_ICONS: Record<string, { icon: LucideIcon; tone: string }> = {
  print_completed: { icon: CheckCircle, tone: 'text-status-ok' },
  print_failed: { icon: XCircle, tone: 'text-status-error' },
  print_cancelled: { icon: Ban, tone: 'text-status-error/70' },
  print_started: { icon: Printer, tone: 'text-yellow-500' },
  queued: { icon: ListTodo, tone: 'text-bambu-gray' },
  auto_queued: { icon: Shuffle, tone: 'text-bambu-gray' },
  project_created: { icon: Plus, tone: 'text-bambu-gray' },
};

/** The whole feed arrives at once; the panel shows a readable slice until asked. */
const TIMELINE_COLLAPSED = 10;

interface OrderTimelineProps {
  orderId: number;
  headingLevel?: 2 | 3;
}

/**
 * «Activity» — the order page's side panel (WS-13 E3 G05): what has happened to
 * this order, newest first, on a vertical line — an icon per kind, the sentence,
 * then when and who. The server sends the last 50; the panel shows ten until
 * asked for the rest.
 *
 * ⚠️ **The label is translated from `event_type`, never taken from the wire.**
 * The server's `title` is English and exists for API callers; it is the
 * fallback for an event type this build has no word for yet, so a new backend
 * event degrades to readable English instead of a blank row.
 */
export function OrderTimeline({ orderId, headingLevel = 2 }: OrderTimelineProps) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const { data: timeline, isLoading, isError, refetch } = useQuery({
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
    <WorkshopPanel data-testid="order-activity-panel" title={t('orders.timeline.title')} headingLevel={headingLevel} flush>
      <div className="px-4 py-3">
        {isError && timeline && <RefreshFailedNote onRetry={() => void refetch()} />}
        {isLoading ? (
          <LoadingBlock label={t('common.loading')} className="py-4 text-bambu-gray" />
        ) : isError && !timeline ? (
          // A journal that could not be read is not an empty one (review 7).
          <div className="flex flex-wrap items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <span>{t('orders.timeline.error')}</span>
            <Button size="sm" variant="secondary" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : timeline && timeline.length > 0 ? (
          <>
            <ol>
              {(expanded ? timeline : timeline.slice(0, TIMELINE_COLLAPSED)).map((event, index) => {
                const known = EVENT_ICONS[event.event_type];
                const Icon = known?.icon ?? JOURNAL_ICONS[event.event_type as keyof typeof JOURNAL_ICONS] ?? CircleDot;
                return (
                  <li
                    key={`${event.timestamp}-${index}`}
                    className="relative border-l border-bambu-dark-tertiary pb-4 pl-[18px] text-[13px] leading-[18px] last:pb-0"
                  >
                    <span className="absolute -left-[7px] top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-bambu-dark-secondary">
                      <Icon className={`h-3.5 w-3.5 ${known?.tone ?? 'text-bambu-green'}`} aria-hidden />
                    </span>
                    <p className="text-white">
                      {journalText(event, t) ??
                        (i18n.exists(`orders.timeline.events.${event.event_type}`)
                          ? t(`orders.timeline.events.${event.event_type}`)
                          : event.title)}
                    </p>
                    {event.description && <p className="truncate text-xs text-bambu-gray">{event.description}</p>}
                    <small className="mt-0.5 block text-xs text-bambu-gray">
                      {when(event.timestamp)}
                      {/* Who did it — the journal's name snapshot (spec workshop-order-stage, rule 35). */}
                      {typeof event.metadata?.user_name === 'string' && <span> · {event.metadata.user_name}</span>}
                    </small>
                  </li>
                );
              })}
            </ol>

            {timeline.length > TIMELINE_COLLAPSED && (
              <button
                type="button"
                onClick={() => setExpanded((open) => !open)}
                className="mt-3 text-xs text-bambu-green hover:underline"
              >
                {expanded
                  ? t('orders.timeline.showLess')
                  : t('orders.timeline.showMore', { count: timeline.length - TIMELINE_COLLAPSED })}
              </button>
            )}
          </>
        ) : (
          <p className="text-sm text-bambu-gray">{t('orders.timeline.empty')}</p>
        )}
      </div>
    </WorkshopPanel>
  );
}
