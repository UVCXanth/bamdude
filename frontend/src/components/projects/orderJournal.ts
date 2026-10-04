import type { TFunction } from 'i18next';
import type { TimelineEvent } from '../../api/client';

/**
 * The order journal's codes — the backend's closed list
 * (`services/order_journal.py::EVENT_KINDS`, spec workshop-order-stage, rule 17),
 * pinned against it and against both locales in `locales.test.ts`.
 */
export const ORDER_JOURNAL_KINDS = [
  'order_created', 'status_changed', 'fields_changed', 'responsible_changed', 'stage_changed',
  'line_added', 'line_changed', 'line_removed', 'line_configured',
  'prints_filed', 'prints_unfiled', 'prints_relined', 'print_trashed', 'print_restored', 'defects_recorded',
  'queue_items_filed', 'queue_items_unfiled', 'plan_enqueued', 'line_rebalanced',
  'surplus_banked', 'procurement_updated',
  'kits_assembled', 'goods_received', 'goods_issued', 'stock_taken', 'goods_written_off', 'goods_stocked',
  'attachment_added', 'attachment_removed', 'cover_changed',
] as const;

type JournalKind = (typeof ORDER_JOURNAL_KINDS)[number];

/** A configuration snapshot of `line_configured` — `{choices: [[group, option]], changed: [[part, qty]]}`,
 *  names only; the sentence is composed here, in the reader's language. */
function configText(snapshot: unknown, t: TFunction): string {
  const s = snapshot && typeof snapshot === 'object' ? (snapshot as { choices?: unknown; changed?: unknown }) : {};
  const choices = Array.isArray(s.choices) ? s.choices : [];
  const changed = Array.isArray(s.changed) ? s.changed : [];
  const bits = choices
    .filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2)
    .map(([group, option]) => `${group}: ${option}`);
  if (changed.length) bits.push(t('orders.lineConfig.changedParts', { count: changed.length }));
  return bits.length ? bits.join(' · ') : t('orders.lineConfig.standard');
}

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
    case 'line_added': {
      // What the line took off each shelf rides on the same entry (spec
      // workshop-add-to-order, rule 11) — said only when it took something.
      const bits = [t('orders.timeline.events.line_added', { product: named(m.product), quantity: text(m.quantity) })];
      const ready = Number(m.from_finished) || 0;
      const kits = Number(m.from_stock) || 0;
      if (ready > 0) bits.push(t('orders.timeline.stock.ready', { count: ready }));
      if (kits > 0) bits.push(t('orders.timeline.stock.kits', { count: kits }));
      return bits.join(', ');
    }
    case 'line_changed': {
      const changes = m.changes && typeof m.changes === 'object' ? Object.keys(m.changes) : [];
      return t('orders.timeline.events.line_changed', { product: named(m.product), fields: fieldList(changes, t) });
    }
    case 'goods_received': {
      // A parts line receives part by part: `parts` is `[[name, n], …]` (spec workshop-order-issue, rule 24).
      const units = Array.isArray(m.parts)
        ? m.parts
            .filter((pair): pair is [unknown, unknown] => Array.isArray(pair) && pair.length === 2)
            .map(([name, n]) => `${named(name)} × ${text(n)}`)
            .join(', ')
        : text(m.units);
      return t('orders.timeline.events.goods_received', { product: named(m.product), units });
    }
    case 'goods_written_off':
    case 'goods_stocked': {
      // Per line, like `goods_received`; a parts line names its parts (followups, rules 38, 46).
      const units = Array.isArray(m.parts)
        ? m.parts
            .filter((pair): pair is [unknown, unknown] => Array.isArray(pair) && pair.length === 2)
            .map(([name, n]) => `${named(name)} × ${text(n)}`)
            .join(', ')
        : text(m.units);
      const said = t(`orders.timeline.events.${event.event_type}`, { product: named(m.product), units });
      return m.note ? `${said} (${text(m.note)})` : said;
    }
    case 'goods_issued': {
      const said = t('orders.timeline.events.goods_issued', { units: text(m.units) });
      return m.waybill ? `${said}${t('orders.timeline.stock.waybill', { waybill: text(m.waybill) })}` : said;
    }
    case 'stock_taken': {
      const bits = [t('orders.timeline.events.stock_taken', { product: named(m.product) })];
      const ready = Number(m.from_finished) || 0;
      const kits = Number(m.kits) || 0;
      if (ready > 0) bits.push(t('orders.timeline.stock.ready', { count: ready }));
      if (kits > 0) bits.push(t('orders.timeline.stock.kits', { count: kits }));
      return bits.join(', ');
    }
    case 'prints_relined':
      // The line a print went to — «other prints» when it left every line (WS-13 E13 O08).
      return t('orders.timeline.events.prints_relined', {
        count: Number(m.count) || 0,
        line: m.line_id == null ? t('orders.prints.otherPrints') : named(m.product),
      });
    case 'print_trashed':
    case 'print_restored':
      return t(`orders.timeline.events.${event.event_type}`, { name: named(m.name) });
    case 'line_configured':
      return t('orders.timeline.events.line_configured', { product: named(m.product), config: configText(m.to, t) });
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
