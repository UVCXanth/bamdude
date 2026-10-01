import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import type { OrderListItem, OrderStage } from '../../../api/client';
import { PriorityBadge } from '../PriorityBadge';
import { StageBadge } from '../StageBadge';
import { OrderActionMenu } from '../orderActions/OrderActionMenu';
import { toOrderRef } from '../orderActions/orderRef';
import type { OrderActions } from '../orderActions/useOrderActions';
import { LiveCounts } from '../orderRow/LiveCounts';
import { OrderCoverage } from '../orderRow/OrderCoverage';
import { OrderDue } from '../orderRow/OrderDue';
import { OrderResponsible } from '../orderRow/OrderResponsible';
import { OrderThumbs } from '../orderRow/OrderThumbs';
import { BoardStageMenu } from './BoardStageMenu';
import type { BoardColumnKey } from './boardDrop';

interface BoardCardProps {
  order: OrderListItem;
  column: BoardColumnKey;
  /** False for «done» and for a viewer who may not change orders — no handle, no stage menu. */
  draggable: boolean;
  /** The page's order action host (WS-13 E6 B01): the card's menu, and «Done…» of its stage menu. */
  actions: OrderActions;
  /** Its stage is being written (WS-13 E7 F05). */
  pending: boolean;
  onStage: (stage: OrderStage) => void;
}

/**
 * One compact order on the kanban — the mockup's `orderCard(o, true)` (WS-13 E7
 * F03): a 3 px rail; thumbnails, code and the stage (a menu for whoever may
 * change it, F07) with the drag handle; the name; customer and priority;
 * coverage; one line of due · print · queue; «issued X of Y»; and a footer with
 * the responsible person and the order menu. Every figure is the server's.
 *
 * The card is dragged by its HANDLE only, so a click (or Enter) on the card
 * still opens the order: the link is an overlay under the handle and the menus,
 * which sit above it (`relative z-10`) and start no drag.
 */
export function BoardCard({ order, column, draggable, actions, pending, onStage }: BoardCardProps) {
  const { t } = useTranslation();
  const canMove = draggable && !pending;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: order.id,
    data: { from: column, code: order.code },
    disabled: !canMove,
  });
  const hasDue = !!order.due_date;
  const live = order.prints_in_progress > 0 || order.prints_queued > 0;

  return (
    <div
      ref={setNodeRef}
      data-testid={`board-card-${order.id}`}
      aria-busy={pending ? 'true' : undefined}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={`relative overflow-hidden rounded-lg bg-bambu-dark border border-bambu-dark-tertiary hover:border-bambu-green/50 ${
        isDragging ? 'z-40 shadow-xl opacity-90' : ''
      } ${pending ? 'opacity-60' : ''}`}
    >
      <div
        data-part="rail"
        className={`h-[3px] ${order.color ? '' : 'bg-bambu-dark-tertiary'}`}
        style={order.color ? { backgroundColor: order.color } : undefined}
      />
      <div className="p-3 space-y-1.5">
        {/* Wraps rather than cutting: a 240 px column holds a wide stage badge and the handle,
            and the code is read whole (it is how the card is named in speech). */}
        <div data-part="top" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <OrderThumbs order={order} />
          <span data-code className="flex-shrink-0 whitespace-nowrap text-xs text-bambu-gray">
            {order.code}
          </span>
          <span className="ml-auto flex flex-shrink-0 items-center gap-1">
            {draggable ? (
              <BoardStageMenu
                order={order}
                pending={pending}
                onStage={onStage}
                onComplete={() => actions.run('complete', toOrderRef(order))}
              />
            ) : (
              <StageBadge stage={order.stage} status={order.status} />
            )}
            {canMove && (
              <button
                type="button"
                ref={setActivatorNodeRef}
                {...attributes}
                {...listeners}
                aria-label={t('orders.board.drag', { code: order.code })}
                className="relative z-10 p-1 rounded text-bambu-gray hover:text-white cursor-grab touch-none focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
              >
                <GripVertical className="w-4 h-4" />
              </button>
            )}
          </span>
        </div>

        <h4 data-part="name" className="text-sm font-semibold text-white break-words">
          {order.name}
        </h4>
        <p data-part="customer" className="flex flex-wrap items-center gap-1.5 text-xs text-bambu-gray">
          <span className="truncate">{order.customer_name ?? t('orders.list.noCustomer')}</span>
          <PriorityBadge priority={order.priority} />
        </p>

        <div data-part="coverage">
          <OrderCoverage order={order} variant="card" />
        </div>

        <p data-part="line" className="flex flex-wrap items-center gap-x-1.5 text-xs text-bambu-gray">
          {hasDue && <OrderDue order={order} variant="inline" />}
          {hasDue && live && <span aria-hidden="true">·</span>}
          {live && <LiveCounts order={order} />}
          {pending && <span className="text-bambu-green">{t('orders.board.moving')}</span>}
        </p>

        {/* The list card's line, the same rule (spec workshop-order-issue-followups, rule 50). */}
        {order.status === 'active' && order.issued_units > 0 && (
          <p className="text-xs text-bambu-gray" data-testid={`board-card-${order.id}-issued`}>
            {t('orders.row.issued', { issued: order.issued_units, ordered: order.ordered })}
          </p>
        )}

        <div data-part="footer" className="flex items-center justify-between gap-2 border-t border-bambu-dark-tertiary pt-2">
          <OrderResponsible order={order} className="min-w-0 truncate text-xs text-bambu-gray" />
          <div className="relative z-10 flex-shrink-0">
            <OrderActionMenu order={toOrderRef(order)} context="list" actions={actions} extra={{ order }} testId={`order-${order.id}-menu`} />
          </div>
        </div>
      </div>

      <Link
        to={`/projects/${order.id}`}
        aria-label={order.name}
        className="absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
      />
    </div>
  );
}
