import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ChevronUp, Check, ListPlus, Pencil, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { api } from '../../api/client';
import type { Order, ProjectLine, ProjectLineUpdate, StockSuggestItem } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useProductStock } from '../../hooks/useProductStock';
import { useConfigurationKits } from '../../hooks/useConfigurationKits';
import { ConfirmModal } from '../ConfirmModal';
import { ProgressBar } from './ProgressBar';
import { LinePartsTable } from './LinePartsTable';
import { AddToOrderDialog } from './add-to-order/AddToOrderDialog';
import { Button } from '../Button';
import { LineConfigDialog } from './LineConfigDialog';
import { lineConfigLabel } from './lineConfigLabel';
import { invalidateOrderViews } from '../../utils/queryInvalidation';

const FIELD_CLASS =
  'px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';
const ICON_BUTTON_CLASS =
  'p-1.5 rounded-lg text-bambu-gray hover:text-white hover:bg-bambu-dark transition-colors disabled:opacity-40 disabled:hover:bg-transparent';

/** What an inline edit is holding, before anything is sent. */
interface Draft {
  id: number;
  /** Not edited — carried so the row's stock query has a product to ask about
   *  without the hook having to search the order for the line again. */
  productId: number;
  quantity: number;
  material: string;
  color: string;
  note: string;
  /** Kits this line takes off the shelf (pass 8, Decision 4). */
  fromStock: number;
  /** Ready units off the finished-goods shelf (spec workshop-add-to-order, rule 13). */
  fromFinished: number;
}

/** Has the line's stock moved — assembled, received, issued or written off (spec
 *  workshop-order-issue, rule 13; followups, rule 44)? From then on its ready units are only
 *  added to, through «take from stock», its kits only come down (followups, rule 42), its
 *  configuration stays, and its quantity stays above what is issued and held. */
function stockMoved(line: ProjectLine): boolean {
  return line.assembled > 0 || line.received > 0 || line.issued > 0 || (line.written_off ?? 0) > 0;
}

/** The kits the line still holds unassembled — what the kits box edits: `from_kit_units`
 *  counts assembled kits too (spec workshop-order-issue, rule 23). */
function liveKits(line: ProjectLine): number {
  return Math.max(0, line.from_kit_units - (line.assembled ?? 0));
}

function draftOf(line: ProjectLine): Draft {
  return {
    id: line.id,
    productId: line.product_id,
    quantity: line.quantity,
    material: line.material ?? '',
    color: line.color ?? '',
    note: line.note ?? '',
    // ⚠️ The KITS, not `from_stock_units`: in the figures that is every unit
    // from stock, ready units included (rule 14); the request field of the same
    // name is kits alone.
    fromStock: liveKits(line),
    fromFinished: line.from_finished,
  };
}

/** The line as `/stock/suggest` asks about it — its own reservation counts as free for it. */
function suggestItemFor(line: ProjectLine, quantity: number): StockSuggestItem {
  const config = line.configuration;
  const item: StockSuggestItem = {
    product_id: line.product_id,
    options: config ? config.choices.map((c) => c.option_id) : [],
    quantity,
    line_id: line.id,
  };
  if (config && config.changed_parts.length > 0) {
    item.part_counts = Object.fromEntries(config.changed_parts.map((p) => [p.part_id, p.qty]));
  }
  return item;
}

/**
 * Only what the operator actually changed.
 *
 * A PATCH carrying every field would overwrite a value somebody else edited
 * between this row rendering and Save being pressed — and, worse, would write
 * back whatever the row was showing for fields the operator never touched.
 * An empty box means null on the wire, never `""`.
 *
 * ⚠️ The material is upper-cased HERE too, not only on the field's blur: the
 * server stores it verbatim, so a row that arrived holding a lower-case
 * `petg` (typed before this page existed) would otherwise keep failing to
 * match the plates, which spell theirs upper-case. Saving such a row repairs
 * it, which is why the comparison can report a change the operator did not
 * type.
 */
function changedFields(line: ProjectLine, draft: Draft): ProjectLineUpdate {
  const patch: ProjectLineUpdate = {};
  if (draft.quantity !== line.quantity) patch.quantity = draft.quantity;
  const material = draft.material.trim().toUpperCase() || null;
  if (material !== (line.material ?? null)) patch.material = material;
  const color = draft.color.trim() || null;
  if (color !== (line.color ?? null)) patch.color = color;
  const note = draft.note.trim() || null;
  if (note !== (line.note ?? null)) patch.note = note;
  // ⚠️ Sent only when the operator MOVED the box. On this field alone, absent
  // means "leave the reservation alone" and a number means "rewrite it"
  // (release + reserve in one server transaction) — so restating the current
  // value would burn a rewrite, and with it the ledger rows that record one,
  // on every save that touched a note.
  if (draft.fromStock !== liveKits(line)) patch.from_stock_units = draft.fromStock;
  // The same rule for the ready units: absent leaves them alone.
  if (draft.fromFinished !== line.from_finished) patch.from_finished = draft.fromFinished;
  return patch;
}

interface OrderLinesTableProps {
  order: Order;
  canEdit: boolean;
}

/**
 * The order's work, one row per line.
 *
 * `units_printed` and `progress` are the server's (design decision 8); this
 * table shows them and never counts archives itself.
 *
 * ⚠️ **Reordering is TWO patches that swap two `sort_order` values**, not a
 * renumbering of the whole list. There is no bulk-reorder endpoint, and a
 * client that renumbered every row would push its own idea of the order over
 * whatever another session had just done. Sequential rather than parallel:
 * the pair is a swap, and sending both at once means the second can land
 * first.
 *
 * ⚠️ **Nothing prints from here.** The row's own "print a plate…" picker was
 * the interim answer of pass 2; the plan block below the table replaced it,
 * and a second door onto `PrintModal` from the same page would let an operator
 * queue a plate the plan is not counting.
 */
export function OrderLinesTable({ order, canEdit }: OrderLinesTableProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<ProjectLine | null>(null);
  const [configuring, setConfiguring] = useState<ProjectLine | null>(null);
  const [adding, setAdding] = useState(false);
  // Only an active order takes ready units (spec workshop-add-to-order, rule 7).
  const orderActive = order.status === 'active';

  // `sort_order` is the authority and `id` only breaks its ties, so two lines
  // that share a position still come out in a stable order rather than
  // swapping places on every render.
  const lines = [...order.lines].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  const invalidate = () => {
    // ⚠️ The whole set: a line's quantity, material or colour is what the
    // plan block plans, so an edit here restates it.
    invalidateOrderViews(queryClient, { orderId: order.id });
  };

  // The shelf of the product being edited. `null` while nothing is open, which
  // in TanStack v5 is a DISABLED query — pending, not fetching, asking nothing.
  // The hook owns the key so this and the product page cannot end up fighting
  // over one query's options; see `useProductStock`.
  const { data: editStock } = useProductStock(draft ? draft.productId : null);
  // A configured line holds its own kit, not the product's standard one.
  const editedLine = draft ? order.lines.find((l) => l.id === draft.id) : undefined;
  const editConfig = editedLine?.configuration;
  const nonStandard =
    editConfig != null &&
    (editConfig.choices.some((c) => !c.is_default) || editConfig.changed_parts.length > 0);
  const { data: editKits } = useConfigurationKits(
    draft ? draft.productId : null,
    nonStandard && editConfig
      ? {
          options: editConfig.choices.map((c) => c.option_id),
          counts: Object.fromEntries(editConfig.changed_parts.map((p) => [p.part_id, p.qty])),
        }
      : null,
  );
  const editFreeKits = (nonStandard ? editKits?.kits_available : editStock?.kits_available) ?? 0;
  // Ready units free in the line's own position, its own reservation included —
  // asked of the ONE picking function, as «Pick from stock» is.
  const takesFinished = editedLine != null && editedLine.mode !== 'parts' && orderActive;
  const { data: editSuggest } = useQuery({
    queryKey: ['stock-suggest', 'line', editedLine?.id, editedLine?.config_key],
    queryFn: () => api.suggestStock([suggestItemFor(editedLine as ProjectLine, (editedLine as ProjectLine).quantity)]),
    enabled: takesFinished,
  });
  const editFreeFinished = editSuggest?.items[0]?.finished_free ?? editedLine?.from_finished ?? 0;

  const pick = useMutation({
    mutationFn: ({ line, quantity }: { line: ProjectLine; quantity: number }) =>
      api.suggestStock([suggestItemFor(line, quantity)]),
    onSuccess: (answer, { line }) => {
      const s = answer.items[0];
      if (!s) return;
      setDraft((d) => (d && d.id === line.id ? { ...d, fromFinished: s.from_finished, fromStock: s.from_kits } : d));
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const save = useMutation({
    mutationFn: ({ lineId, data }: { lineId: number; data: ProjectLineUpdate }) =>
      api.updateOrderLine(order.id, lineId, data),
    onSuccess: (saved, { lineId, data }) => {
      // ⚠️ The product's shelf, its `kits_available` and the catalog card that
      // shows it are in `ORDER_VIEW_KEYS` since Ruling 29 — they have to be,
      // because the six call sites that RELEASE stock (a deleted line, a
      // cancelled or deleted order) know no product to scope by. So a rewritten
      // reservation is covered by the call below and NOT invalidated a second
      // time here: two `invalidateQueries` for one key is two refetches of the
      // same product page, which is what the scoped copy used to cost.
      invalidate();
      if (data.from_finished != null) {
        const line = saved.lines.find((l) => l.id === lineId);
        if (line && line.from_finished < data.from_finished) {
          showToast(t('stock.line.clampedFinished', { count: line.from_finished }), 'warning');
        }
      }
      if (data.from_stock_units != null) {
        // What was ACTUALLY reserved can be less than what was asked — the
        // shelf may have emptied since the row was opened. The row is closing,
        // so the honest number is said rather than shown.
        const line = saved.lines.find((l) => l.id === lineId);
        if (line && line.from_kit_units < data.from_stock_units) {
          showToast(t('stock.line.clamped', { n: line.from_kit_units }), 'warning');
        }
      }
      setDraft(null);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const swap = useMutation({
    mutationFn: async ({ a, b }: { a: ProjectLine; b: ProjectLine }) => {
      await api.updateOrderLine(order.id, a.id, { sort_order: b.sort_order });
      await api.updateOrderLine(order.id, b.id, { sort_order: a.sort_order });
    },
    // ⚠️ `onSettled`, NOT `onSuccess`: a swap is two writes and the first can
    // land while the second does not (a dropped connection, a 404 on a line
    // another session just deleted). The server is then holding two lines with
    // the SAME `sort_order` — and on `onSuccess` alone the cache would never be
    // invalidated, so the table would keep drawing the pre-swap order. Both
    // buttons then look broken for ever: swapping equal values is a no-op, and
    // the `id` tiebreak keeps the wrong display perfectly stable. Refetching
    // whatever happened is the only way the operator sees the real state.
    onSettled: invalidate,
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: (lineId: number) => api.deleteOrderLine(order.id, lineId),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  /**
   * Save, unless there is nothing to save.
   *
   * A `PATCH {}` is a request that asks the server to change nothing, bumps the
   * order's `updated_at` and invalidates two query keys for a row the operator
   * only opened and closed. Pressing Save on an untouched row is the same
   * gesture as Cancel, so it does the same thing.
   */
  const commitDraft = (line: ProjectLine, editing: Draft) => {
    const data = changedFields(line, editing);
    if (Object.keys(data).length === 0) {
      setDraft(null);
      return;
    }
    save.mutate({ lineId: line.id, data });
  };

  const toggleExpanded = (lineId: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });

  const busy = save.isPending || swap.isPending || remove.isPending || pick.isPending;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium text-white">{t('orders.lines.title')}</h2>
        {canEdit && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <ListPlus className="w-4 h-4" />
            {t('orders.lines.addToOrder')}
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-bambu-gray text-left">
              <th className="font-normal p-2">{t('orders.lines.product')}</th>
              <th className="font-normal p-2">{t('orders.lines.quantity')}</th>
              <th className="font-normal p-2">{t('orders.lines.material')}</th>
              <th className="font-normal p-2">{t('orders.lines.color')}</th>
              <th className="font-normal p-2">{t('orders.lines.note')}</th>
              <th className="font-normal p-2 min-w-[8rem]">{t('orders.lines.progress')}</th>
              <th className="font-normal p-2 text-right">{t('orders.lines.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={7} className="p-4 text-bambu-gray">
                  {t('orders.lines.empty')}
                </td>
              </tr>
            )}

            {lines.map((line, index) => {
              const editing = draft?.id === line.id ? draft : null;
              const moved = stockMoved(line);
              const quantityFloor = moved ? Math.max(1, line.issued + line.held) : 1;
              const open = expanded.has(line.id);
              return [
                <tr key={line.id} data-line={line.id} className="border-t border-bambu-dark-tertiary text-white">
                  <td className="p-2">
                    <Link to={`/products/${line.product_id}`} className="hover:text-bambu-green transition-colors">
                      {line.product_name}
                    </Link>
                    {(() => {
                      const label = lineConfigLabel(line.configuration, line.mode, t);
                      return (
                        label && (
                          <p className="text-xs text-bambu-gray" data-testid={`line-${line.id}-config`}>
                            {label}
                          </p>
                        )
                      );
                    })()}
                  </td>
                  <td className="p-2 tabular-nums">
                    {/* A parts line is one set of parts: its quantity is fixed at 1
                        and it takes nothing off the shelf (rules 15–16). */}
                    {editing && line.mode !== 'parts' ? (
                      <input
                        type="number"
                        min={quantityFloor}
                        aria-label={t('orders.lines.quantity')}
                        value={editing.quantity}
                        onChange={(e) => {
                          if (moved) {
                            // Moved stock is not rewritten: the quantity alone changes, never
                            // below what went out and what waits on the shelf; the server fits
                            // the kits under it.
                            setDraft({ ...editing, quantity: Math.max(quantityFloor, Number(e.target.value) || quantityFloor) });
                            return;
                          }
                          // ⚠️ Lowering the quantity lowers the reservation with
                          // it. A line for two units holding five kits is not a
                          // reservation, it is stock taken out of circulation —
                          // the server clamps it away anyway (Ruling 16), and a
                          // box left showing five while three go back on the
                          // shelf is the display disagreeing with the write.
                          // Kits go back first, then ready units (spec rule 6).
                          const quantity = Math.max(1, Number(e.target.value) || 1);
                          // ⚠️ Only an ACTIVE order's ready units shrink with it: a
                          // completed one shipped them, and a PATCH naming them there
                          // is refused (final review I3).
                          const fromFinished = orderActive ? Math.min(editing.fromFinished, quantity) : editing.fromFinished;
                          setDraft({
                            ...editing,
                            quantity,
                            fromFinished,
                            fromStock: Math.min(editing.fromStock, Math.max(0, quantity - fromFinished)),
                          });
                        }}
                        className={`${FIELD_CLASS} w-20`}
                      />
                    ) : (
                      line.quantity
                    )}
                    {/* Kits off the shelf, under the quantity because they are
                        the same unit: the line asks for N, and some of those N
                        come from stock instead of a printer. A column of its own
                        would push the table past the width it already has.
                        ⚠️ The editable ceiling is what is FREE plus what this
                        line already holds — an edit releases its own reservation
                        before making the new one, so the line's own kits are back
                        in the pool by the time the server clamps. */}
                    {editing
                      ? (() => {
                          if (line.mode === 'parts') return null;
                          if (moved) {
                            // Kits only come DOWN after a movement — back onto the shelf,
                            // the prints already made take their place (followups, rule 42).
                            const live = liveKits(line);
                            if (live === 0) {
                              return <p className="mt-1 text-xs text-bambu-gray">{t('orders.lines.moved')}</p>;
                            }
                            return (
                              <div className="mt-1 space-y-1">
                                <label className="block text-xs text-bambu-gray" htmlFor={`line-${line.id}-from-stock`}>
                                  {t('stock.line.kitsLabel')}
                                </label>
                                <input
                                  id={`line-${line.id}-from-stock`}
                                  data-testid={`line-${line.id}-from-stock`}
                                  type="number"
                                  min={0}
                                  max={live}
                                  value={editing.fromStock}
                                  onChange={(e) =>
                                    setDraft({
                                      ...editing,
                                      fromStock: Math.min(Math.max(0, Number(e.target.value) || 0), live),
                                    })
                                  }
                                  className={`${FIELD_CLASS} w-20`}
                                />
                                <p className="text-xs text-bambu-gray">{t('orders.lines.movedKitsDown')}</p>
                              </div>
                            );
                          }
                          const pool = editFreeKits + line.from_kit_units;
                          // Ready units come first; kits fit under what is left
                          // (spec workshop-add-to-order, rule 6).
                          const kitsRoom = Math.max(0, editing.quantity - editing.fromFinished);
                          const finishedMax = Math.min(editFreeFinished, editing.quantity);
                          const showFinished = !orderActive
                            ? line.from_finished > 0 || editing.fromFinished > 0
                            : editFreeFinished > 0 || line.from_finished > 0;
                          return (
                            <div className="mt-1 space-y-1">
                              {showFinished && (
                                <div>
                                  <label
                                    className="block text-xs text-bambu-gray"
                                    htmlFor={`line-${line.id}-from-finished`}
                                  >
                                    {t('stock.line.readyLabel')}
                                  </label>
                                  <input
                                    id={`line-${line.id}-from-finished`}
                                    data-testid={`line-${line.id}-from-finished`}
                                    type="number"
                                    min={0}
                                    max={finishedMax}
                                    value={editing.fromFinished}
                                    disabled={!orderActive}
                                    title={!orderActive ? t('stock.line.finishedActiveOnly') : undefined}
                                    onChange={(e) => {
                                      const fromFinished = Math.min(Math.max(0, Number(e.target.value) || 0), finishedMax);
                                      setDraft({
                                        ...editing,
                                        fromFinished,
                                        fromStock: Math.min(editing.fromStock, editing.quantity - fromFinished),
                                      });
                                    }}
                                    className={`${FIELD_CLASS} w-20 disabled:opacity-50`}
                                  />
                                  {!orderActive && (
                                    <p className="text-xs text-bambu-gray">{t('stock.line.finishedActiveOnly')}</p>
                                  )}
                                </div>
                              )}
                              {pool > 0 && (
                                <div>
                                  <label className="block text-xs text-bambu-gray" htmlFor={`line-${line.id}-from-stock`}>
                                    {t('stock.line.kitsLabel')}
                                  </label>
                                  <input
                                    id={`line-${line.id}-from-stock`}
                                    data-testid={`line-${line.id}-from-stock`}
                                    type="number"
                                    min={0}
                                    max={Math.min(pool, kitsRoom)}
                                    value={editing.fromStock}
                                    // ⚠️ **The DRAFT is clamped, not the display**
                                    // (finding I2). While the ceiling was applied
                                    // only to `value`, the box showed 2 and the
                                    // draft held the 7 that was typed: the save sent
                                    // 7, the server clamped it back to 2, and an
                                    // edit that changed nothing but a note burned a
                                    // release-and-retake on the ledger — while
                                    // warning about a clamp the operator never saw.
                                    // `changedFields` still sends the field only
                                    // when it MOVED.
                                    onChange={(e) =>
                                      setDraft({
                                        ...editing,
                                        fromStock: Math.min(Math.max(0, Number(e.target.value) || 0), kitsRoom, pool),
                                      })
                                    }
                                    className={`${FIELD_CLASS} w-20`}
                                  />
                                </div>
                              )}
                              {orderActive && (
                                <button
                                  type="button"
                                  onClick={() => pick.mutate({ line, quantity: editing.quantity })}
                                  disabled={busy}
                                  className="text-xs text-bambu-green hover:underline disabled:opacity-50"
                                >
                                  {t('stock.line.pick')}
                                </button>
                              )}
                            </div>
                          );
                        })()
                      : (line.from_finished > 0 || line.from_kit_units > 0) && (
                          <p className="text-xs text-bambu-gray" data-testid={`line-${line.id}-from-stock-shown`}>
                            {t('stock.line.split', { ready: line.from_finished, kits: line.from_kit_units })}
                          </p>
                        )}
                  </td>
                  <td className="p-2">
                    {editing ? (
                      <input
                        type="text"
                        aria-label={t('orders.lines.material')}
                        value={editing.material}
                        onChange={(e) => setDraft({ ...editing, material: e.target.value })}
                        onBlur={() => setDraft({ ...editing, material: editing.material.trim().toUpperCase() })}
                        className={`${FIELD_CLASS} w-24`}
                      />
                    ) : (
                      line.material || <span className="text-bambu-gray">—</span>
                    )}
                  </td>
                  <td className="p-2">
                    {editing ? (
                      <input
                        type="text"
                        aria-label={t('orders.lines.color')}
                        value={editing.color}
                        onChange={(e) => setDraft({ ...editing, color: e.target.value })}
                        className={`${FIELD_CLASS} w-24`}
                      />
                    ) : (
                      line.color || <span className="text-bambu-gray">—</span>
                    )}
                  </td>
                  <td className="p-2">
                    {editing ? (
                      <input
                        type="text"
                        aria-label={t('orders.lines.note')}
                        value={editing.note}
                        onChange={(e) => setDraft({ ...editing, note: e.target.value })}
                        className={FIELD_CLASS}
                      />
                    ) : (
                      line.note || <span className="text-bambu-gray">—</span>
                    )}
                  </td>
                  <td className="p-2">
                    <ProgressBar value={line.covered_units} max={line.quantity} progress={line.progress} testId={`line-${line.id}-progress`} />
                    <p className="text-xs text-bambu-gray mt-1 tabular-nums" data-testid={`line-${line.id}-coverage-sources`}>
                      {t('orders.lines.coverageSources', { printed: line.units_printed, stock: line.from_stock_units })}
                    </p>
                    {(line.issued > 0 || line.held > 0) && (
                      <p className="text-xs text-bambu-gray mt-1 tabular-nums" data-testid={`line-${line.id}-issued`}>
                        {t('orders.lines.issuedHeld', { issued: line.issued, ordered: line.quantity, held: line.held })}
                      </p>
                    )}
                    {(line.prints_in_progress > 0 || line.prints_queued > 0) && (
                      <p className="text-xs text-bambu-gray mt-1" data-testid={`line-${line.id}-live`}>
                        {t('orders.lines.live', { printing: line.prints_in_progress, queued: line.prints_queued })}
                      </p>
                    )}
                  </td>
                  <td className="p-2">
                    <div className="flex items-center justify-end gap-0.5">
                      <button
                        type="button"
                        data-testid={`line-${line.id}-expand`}
                        onClick={() => toggleExpanded(line.id)}
                        title={open ? t('orders.lines.collapse') : t('orders.lines.expand')}
                        aria-label={open ? t('orders.lines.collapse') : t('orders.lines.expand')}
                        className={ICON_BUTTON_CLASS}
                      >
                        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </button>

                      {canEdit && editing && (
                        <>
                          <button
                            type="button"
                            data-testid={`line-${line.id}-save`}
                            onClick={() => commitDraft(line, editing)}
                            disabled={busy}
                            title={t('orders.lines.save')}
                            aria-label={t('orders.lines.save')}
                            className={ICON_BUTTON_CLASS}
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDraft(null)}
                            title={t('orders.lines.cancel')}
                            aria-label={t('orders.lines.cancel')}
                            className={ICON_BUTTON_CLASS}
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </>
                      )}

                      {canEdit && !editing && (
                        <>
                          <button
                            type="button"
                            data-testid={`line-${line.id}-edit`}
                            onClick={() => setDraft(draftOf(line))}
                            title={t('orders.lines.edit')}
                            aria-label={t('orders.lines.edit')}
                            className={ICON_BUTTON_CLASS}
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            data-testid={`line-${line.id}-configure`}
                            onClick={() => setConfiguring(line)}
                            // Its kits shipped; the server refuses (409) — reopen the order first.
                            disabled={order.status === 'completed' || moved}
                            title={
                              order.status === 'completed'
                                ? t('orders.lineConfig.completed')
                                : moved
                                  ? t('orders.lines.moved')
                                  : t('orders.lineConfig.configure')
                            }
                            aria-label={t('orders.lineConfig.configure')}
                            className={ICON_BUTTON_CLASS}
                          >
                            <SlidersHorizontal className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            data-testid={`line-${line.id}-up`}
                            onClick={() => swap.mutate({ a: line, b: lines[index - 1] })}
                            disabled={index === 0 || busy}
                            title={t('orders.lines.moveUp')}
                            aria-label={t('orders.lines.moveUp')}
                            className={ICON_BUTTON_CLASS}
                          >
                            <ChevronUp className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            data-testid={`line-${line.id}-down`}
                            onClick={() => swap.mutate({ a: line, b: lines[index + 1] })}
                            disabled={index === lines.length - 1 || busy}
                            title={t('orders.lines.moveDown')}
                            aria-label={t('orders.lines.moveDown')}
                            className={ICON_BUTTON_CLASS}
                          >
                            <ChevronDown className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            data-testid={`line-${line.id}-delete`}
                            onClick={() => setDeleting(line)}
                            title={t('orders.lines.delete')}
                            aria-label={t('orders.lines.delete')}
                            className={`${ICON_BUTTON_CLASS} hover:text-red-500`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>,
                open ? (
                  <tr key={`${line.id}-parts`} className="bg-bambu-dark/40">
                    <td colSpan={7} className="px-4 pb-3">
                      <LinePartsTable parts={line.parts} mode={line.mode} />
                    </td>
                  </tr>
                ) : null,
              ];
            })}

          </tbody>
        </table>
      </div>

      {adding && (
        <AddToOrderDialog orderId={order.id} orderActive={orderActive} onClose={() => setAdding(false)} />
      )}

      {configuring && (
        <LineConfigDialog orderId={order.id} line={configuring} onClose={() => setConfiguring(null)} />
      )}

      {deleting && (
        <ConfirmModal
          title={t('orders.lines.confirmDeleteTitle')}
          message={t('orders.lines.confirmDelete')}
          variant="danger"
          isLoading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
