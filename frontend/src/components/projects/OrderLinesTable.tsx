import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Clock, ListPlus, Package, Play } from 'lucide-react';
import { api } from '../../api/client';
import type { Order, ProjectLine } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { getColorName } from '../../utils/colors';
import { ConfirmModal } from '../ConfirmModal';
import { CardActionMenu, CardActionMenuItem } from '../CardActionMenu';
import { ProgressBar } from './ProgressBar';
import { LinePartsTable } from './LinePartsTable';
import { LineEditDialog } from './LineEditDialog';
import { AddToOrderDialog } from './add-to-order/AddToOrderDialog';
import { Button } from '../Button';
import { LineConfigDialog } from './LineConfigDialog';
import { lineConfigLabel } from './lineConfigLabel';
import { configBlockedReason } from './lineGates';
import { invalidateOrderViews } from '../../utils/queryInvalidation';
import { WorkshopTableScroll } from '../workshop/WorkshopPanel';

const HEAD = 'font-normal text-xs text-bambu-gray px-3 py-2 whitespace-nowrap';
const CELL = 'px-3 py-2.5 align-top';
const AMBER = 'text-amber-700 dark:text-amber-400';
const HEX = /^#?[0-9a-f]{6}([0-9a-f]{2})?$/i;

/** The configuration caption of B02: what a parts line wants, a non-standard kit, or
 *  «standard configuration» — the first two in amber, the last muted. */
function configCaption(line: ProjectLine, t: ReturnType<typeof useTranslation>['t']) {
  if (line.mode === 'parts') {
    const parts = line.parts.map((p) => `${p.name} × ${p.need}`).join(', ');
    return { text: t('orders.lines.partsOnlyList', { parts }), accent: true };
  }
  const config = line.configuration;
  const nonStandard =
    config != null && (config.choices.some((c) => !c.is_default) || config.changed_parts.length > 0);
  if (nonStandard) return { text: lineConfigLabel(config, line.mode, t), accent: true };
  return { text: t('orders.lines.standardConfig'), accent: false };
}

interface OrderLinesTableProps {
  order: Order;
  canEdit: boolean;
  /** 2 on the order page; 3 in the workspace pane, whose order title is an h2 (E3 B06). */
  headingLevel?: 2 | 3;
}

/**
 * The order's work, one row per line (WS-13 E4 B, C).
 *
 * The table SHOWS: every figure is the server's (design decision 8) and it never
 * counts archives itself. Everything that changes a line opens from the row's menu —
 * the configuration dialog, «Edit line» (`LineEditDialog`, which owns the draft and
 * its rules), reordering and deleting; the expander on the left is the reader's too.
 *
 * ⚠️ **Reordering is TWO patches that swap two `sort_order` values**, not a
 * renumbering of the whole list. There is no bulk-reorder endpoint, and a client
 * that renumbered every row would push its own idea of the order over whatever
 * another session had just done. Sequential rather than parallel: the pair is a
 * swap, and sending both at once means the second can land first.
 *
 * ⚠️ **Nothing prints from here.** The plan block below owns that; a second door
 * onto `PrintModal` would let an operator queue a plate the plan is not counting.
 */
export function OrderLinesTable({ order, canEdit, headingLevel = 2 }: OrderLinesTableProps) {
  const { t } = useTranslation();
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<ProjectLine | null>(null);
  const [deleting, setDeleting] = useState<ProjectLine | null>(null);
  const [configuring, setConfiguring] = useState<ProjectLine | null>(null);
  const [adding, setAdding] = useState(false);
  const orderActive = order.status === 'active';

  // `sort_order` is the authority and `id` only breaks its ties, so two lines that
  // share a position still come out in a stable order.
  const lines = [...order.lines].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  const invalidate = () => {
    // ⚠️ The whole set: a line is what the plan block plans, and a released
    // reservation moved the product's shelf (Ruling 29).
    invalidateOrderViews(queryClient, { orderId: order.id });
  };

  const swap = useMutation({
    mutationFn: async ({ a, b }: { a: ProjectLine; b: ProjectLine }) => {
      await api.updateOrderLine(order.id, a.id, { sort_order: b.sort_order });
      await api.updateOrderLine(order.id, b.id, { sort_order: a.sort_order });
    },
    // ⚠️ `onSettled`, NOT `onSuccess`: a swap is two writes and the first can land
    // while the second does not. The server then holds two lines with the SAME
    // `sort_order` — on `onSuccess` alone the table would keep drawing the pre-swap
    // order for ever. Refetching whatever happened is the only honest answer.
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

  const toggleExpanded = (lineId: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });

  const busy = swap.isPending || remove.isPending;

  return (
    <section className="space-y-3">
      {/* WS-13 E3 E06: the heading carries the count; the table has no card of its
          own inside the order's main panel — only its own scroll region. */}
      <div className="flex items-center justify-between gap-3">
        <Heading className="text-lg leading-7 font-semibold text-white">
          {t('orders.lines.title')} <small className="text-sm font-normal text-bambu-gray">({order.lines.length})</small>
        </Heading>
        {canEdit && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <ListPlus className="w-4 h-4" />
            {t('orders.lines.addToOrder')}
          </Button>
        )}
      </div>

      <WorkshopTableScroll label={t('orders.lines.title')}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className={`${HEAD} w-8 pr-0`} />
              <th className={HEAD}>{t('orders.lines.productConfig')}</th>
              <th className={HEAD}>{t('orders.lines.quantity')}</th>
              <th className={HEAD}>{t('orders.lines.materialColor')}</th>
              <th className={`${HEAD} min-w-[160px]`}>{t('orders.lines.progress')}</th>
              <th className={`${HEAD} w-px`}>
                <span className="sr-only">{t('orders.lines.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={6} className="p-4 text-bambu-gray border-t border-bambu-dark-tertiary">
                  {t('orders.lines.empty')}
                </td>
              </tr>
            )}

            {lines.map((line, index) => {
              const open = expanded.has(line.id);
              const caption = configCaption(line, t);
              const blocked = configBlockedReason(order, line, t);
              const colorKnown = line.color != null && HEX.test(line.color);
              return [
                <tr key={line.id} data-line={line.id} className="border-t border-bambu-dark-tertiary text-white">
                  <td className={`${CELL} w-8 pr-0`}>
                    <button
                      type="button"
                      data-testid={`line-${line.id}-expand`}
                      onClick={() => toggleExpanded(line.id)}
                      aria-expanded={open}
                      aria-label={open ? t('orders.lines.collapse') : t('orders.lines.expand')}
                      title={open ? t('orders.lines.collapse') : t('orders.lines.expand')}
                      className="p-1 rounded-lg text-bambu-gray hover:text-white hover:bg-bambu-dark transition-colors"
                    >
                      {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                  </td>
                  <td className={CELL}>
                    <div className="flex items-center gap-3">
                      <span
                        data-testid={`line-${line.id}-thumb`}
                        className="w-10 h-10 flex-shrink-0 rounded-lg bg-bambu-dark-tertiary text-bambu-gray grid place-items-center overflow-hidden"
                      >
                        {line.product_has_cover ? (
                          <img
                            src={api.getProductCoverImageUrl(line.product_id)}
                            alt=""
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <Package className="w-[18px] h-[18px]" aria-hidden />
                        )}
                      </span>
                      <div className="min-w-0">
                        <Link to={`/products/${line.product_id}`} className="font-medium text-white hover:underline">
                          {line.product_name}
                        </Link>
                        {(line.product_origin ?? 'catalog') !== 'catalog' && (
                          <span className="ml-1.5 inline-flex items-center rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap bg-gray-200 dark:bg-gray-500/20 text-gray-600 dark:text-gray-400">
                            {t('orders.lines.oneOff')}
                          </span>
                        )}
                        <small className="block mt-0.5 text-xs text-bambu-gray" data-testid={`line-${line.id}-config`}>
                          {line.product_sku && (
                            <>
                              <span className="font-mono text-xs">{line.product_sku}</span>
                              {' · '}
                            </>
                          )}
                          {caption.accent ? (
                            <span data-config-accent className={AMBER}>
                              {caption.text}
                            </span>
                          ) : (
                            caption.text
                          )}
                        </small>
                        {line.note && (
                          <small className="block mt-0.5 text-xs text-bambu-gray" data-testid={`line-${line.id}-note`}>
                            {`«${line.note}»`}
                          </small>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className={`${CELL} tabular-nums`}>
                    <span data-testid={`line-${line.id}-quantity`}>
                      {line.mode === 'parts'
                        ? t('orders.lines.partsQty', { count: line.quantity })
                        : t('orders.lines.unitsQty', { count: line.quantity })}
                    </span>
                    {(line.from_finished > 0 || line.from_kit_units > 0) && (
                      <small className="block mt-0.5 text-xs text-bambu-gray" data-testid={`line-${line.id}-from-stock-shown`}>
                        {t('orders.lines.fromStock', {
                          list: [
                            line.from_finished > 0 && t('orders.lines.fromStockReady', { count: line.from_finished }),
                            line.from_kit_units > 0 && t('orders.lines.fromStockKits', { count: line.from_kit_units }),
                          ]
                            .filter(Boolean)
                            .join(' · '),
                        })}
                      </small>
                    )}
                    {(line.held > 0 || line.issued > 0) && (
                      <small className="block mt-0.5 text-xs text-bambu-green" data-testid={`line-${line.id}-issued`}>
                        {t('orders.lines.heldIssued', { held: line.held, issued: line.issued })}
                      </small>
                    )}
                  </td>
                  <td className={CELL} data-testid={`line-${line.id}-material`}>
                    {line.material || <span className="text-bambu-gray">{t('orders.lines.anyMaterial')}</span>}
                    <small className="block mt-0.5 text-xs" data-testid={`line-${line.id}-color`}>
                      {line.color ? (
                        colorKnown ? (
                          <>
                            <span
                              data-swatch
                              aria-hidden
                              className="inline-block w-2.5 h-2.5 rounded-full border border-bambu-gray mr-1.5 align-[-1px]"
                              style={{ backgroundColor: line.color.startsWith('#') ? line.color.slice(0, 7) : `#${line.color.slice(0, 6)}` }}
                            />
                            {getColorName(line.color)}
                          </>
                        ) : (
                          line.color
                        )
                      ) : (
                        <span className="text-bambu-gray">{t('orders.lines.anyColor')}</span>
                      )}
                    </small>
                  </td>
                  <td className={`${CELL} min-w-[160px]`}>
                    <ProgressBar
                      value={line.covered_units}
                      max={line.quantity}
                      progress={line.progress}
                      label={`${line.covered_units} / ${line.quantity}`}
                      caption="percent"
                      testId={`line-${line.id}-progress`}
                    />
                    <small className="block mt-1 text-xs text-bambu-gray tabular-nums">
                      <span data-testid={`line-${line.id}-coverage-sources`}>
                        {line.mode === 'parts' || line.from_stock_units === 0
                          ? t('orders.lines.printedOnly', { printed: line.units_printed })
                          : t('orders.lines.coverageSources', { printed: line.units_printed, stock: line.from_stock_units })}
                      </span>
                      {(line.prints_in_progress > 0 || line.prints_queued > 0) && (
                        <span data-testid={`line-${line.id}-live`}>
                          <span className="sr-only">
                            {t('orders.lines.live', { printing: line.prints_in_progress, queued: line.prints_queued })}
                          </span>
                          <span aria-hidden className="inline-flex items-center gap-1">
                            {' · '}
                            <Play className="w-3 h-3" />
                            {line.prints_in_progress}
                            <Clock className="w-3 h-3 ml-1" />
                            {line.prints_queued}
                          </span>
                        </span>
                      )}
                    </small>
                  </td>
                  <td className={`${CELL} w-px text-right whitespace-nowrap`}>
                    {canEdit && (
                      <CardActionMenu
                        label={t('orders.lines.menu', { product: line.product_name })}
                        width="max-content"
                        estimatedHeight={240}
                      >
                        {(close) => (
                          <>
                            <CardActionMenuItem
                              disabled={blocked != null}
                              title={blocked ?? undefined}
                              onSelect={() => {
                                close();
                                setConfiguring(line);
                              }}
                            >
                              {t('orders.lines.menuConfigure')}
                            </CardActionMenuItem>
                            <CardActionMenuItem
                              onSelect={() => {
                                close();
                                setEditing(line);
                              }}
                            >
                              {t('orders.lines.menuEdit')}
                            </CardActionMenuItem>
                            <CardActionMenuItem
                              disabled={index === 0 || busy}
                              onSelect={() => {
                                close();
                                swap.mutate({ a: line, b: lines[index - 1] });
                              }}
                            >
                              {t('orders.lines.moveUp')}
                            </CardActionMenuItem>
                            <CardActionMenuItem
                              disabled={index === lines.length - 1 || busy}
                              onSelect={() => {
                                close();
                                swap.mutate({ a: line, b: lines[index + 1] });
                              }}
                            >
                              {t('orders.lines.moveDown')}
                            </CardActionMenuItem>
                            <div role="separator" className="my-1 border-t border-bambu-dark-tertiary" />
                            <CardActionMenuItem
                              danger
                              onSelect={() => {
                                close();
                                setDeleting(line);
                              }}
                            >
                              {t('orders.lines.delete')}
                            </CardActionMenuItem>
                          </>
                        )}
                      </CardActionMenu>
                    )}
                  </td>
                </tr>,
                open ? (
                  <tr key={`${line.id}-parts`}>
                    <td className="bg-bambu-dark-tertiary/30" />
                    <td colSpan={5} className="bg-bambu-dark-tertiary/30 px-3 py-1">
                      <LinePartsTable parts={line.parts} purchased={line.purchased ?? []} mode={line.mode} />
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </WorkshopTableScroll>

      {adding && <AddToOrderDialog orderId={order.id} orderActive={orderActive} onClose={() => setAdding(false)} />}

      {editing && (
        <LineEditDialog
          order={order}
          // The CURRENT line; the dialog's draft is its own from the moment it opened.
          line={order.lines.find((l) => l.id === editing.id) ?? editing}
          onClose={() => setEditing(null)}
          onConfigure={() => {
            // The configuration dialog seeds from the line it is given and PUTs the whole
            // body — so it gets the line as the order holds it now (final review M2).
            setConfiguring(order.lines.find((l) => l.id === editing.id) ?? editing);
            setEditing(null);
          }}
        />
      )}

      {configuring && <LineConfigDialog orderId={order.id} line={configuring} onClose={() => setConfiguring(null)} />}

      {deleting && (
        <ConfirmModal
          title={t('orders.lines.confirmDeleteTitle', { product: deleting.product_name })}
          message={t('orders.lines.confirmDelete')}
          confirmText={t('orders.lines.confirmDeleteAction')}
          variant="danger"
          isLoading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
