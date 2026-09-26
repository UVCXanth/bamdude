import type { TFunction } from 'i18next';
import type { TimelineEvent } from '../../api/client';

/**
 * The order journal's codes — the backend's closed list
 * (`services/order_journal.py::EVENT_KINDS`, spec workshop-order-stage, rule 17),
 * pinned against it and against both locales in `locales.test.ts`.
 */
export const ORDER_JOURNAL_KINDS = [
  'order_created', 'status_changed', 'fields_changed', 'responsible_changed', 'stage_changed',
  'line_added', 'line_changed', 'line_removed',
  'prints_filed', 'prints_unfiled', 'defects_recorded',
  'queue_items_filed', 'plan_enqueued', 'line_rebalanced',
  'surplus_banked', 'procurement_updated',
  'attachment_added', 'attachment_removed', 'cover_changed',
] as const;

type JournalKind = (typeof ORDER_JOURNAL_KINDS)[number];

const isJournalKind = (kind: string): kind is JournalKind => (ORDER_JOURNAL_KINDS as readonly string[]).includes(kind);

const text = (value: unknown): string => (value == null ? '' : String(value));

/** A name snapshot for a sentence — «—» when the thing named is gone (e.g. a deleted product). */
const named = (value: unknown): string => text(value) || '—';

/** Field codes («name», «due_date») in the reader's language, joined. */
function fieldList(fields: unknown, t: TFunction): string {
  if (!Array.isArray(fields)) return '';
  return fields.map((field) => t(`orders.timeline.fields.${field}`, { defaultValue: String(field) })).join(', ');
}

/** A `{id, name}` snapshot of a user, or «Not assigned» for nobody. */
function person(ref: unknown, t: TFunction): string {
  if (ref && typeof ref === 'object' && 'name' in ref && ref.name) return String(ref.name);
  return t('orders.modal.noResponsible');
}

/**
 * The sentence for a journal line, or `null` when the event is not one — the
 * print and queue events keep their own labels. The journal stores codes and
 * values, never sentences (rule 16), so every word is built here.
 */
export function journalText(event: TimelineEvent, t: TFunction): string | null {
  if (!isJournalKind(event.event_type)) return null;
  const m = event.metadata ?? {};
  switch (event.event_type) {
    case 'order_created':
      if (m.source === 'copy') return t('orders.timeline.created.copy', { code: text(m.from_code) });
      if (m.source === 'files') return t('orders.timeline.created.files');
      return t('orders.timeline.events.order_created');
    case 'status_changed':
      return t('orders.timeline.events.status_changed', {
        from: t(`orders.status.${text(m.from)}`),
        to: t(`orders.status.${text(m.to)}`),
      });
    case 'stage_changed':
      return t('orders.timeline.events.stage_changed', {
        from: t(`orders.stage.${text(m.from)}`),
        to: t(`orders.stage.${text(m.to)}`),
      });
    case 'fields_changed':
      return t('orders.timeline.events.fields_changed', { fields: fieldList(m.fields, t) });
    case 'responsible_changed':
      return t('orders.timeline.events.responsible_changed', { from: person(m.from, t), to: person(m.to, t) });
    case 'line_changed': {
      const changes = m.changes && typeof m.changes === 'object' ? Object.keys(m.changes) : [];
      return t('orders.timeline.events.line_changed', { product: named(m.product), fields: fieldList(changes, t) });
    }
    case 'cover_changed':
      return t(`orders.timeline.cover.${m.action === 'removed' ? 'removed' : 'set'}`);
    default:
      // Name snapshots may be null (the product was gone when the line was written).
      return t(`orders.timeline.events.${event.event_type}`, {
        ...m,
        product: named(m.product),
        part: named(m.part),
        filename: named(m.filename),
      });
  }
}
