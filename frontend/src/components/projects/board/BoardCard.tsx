import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import type { OrderListItem } from '../../../api/client';
import { isOverdue } from '../../../utils/orderDates';
import { PriorityBadge } from '../PriorityBadge';
import { ProgressBar } from '../ProgressBar';
import { ResponsibleName } from '../ResponsibleName';
import type { BoardColumnKey } from './boardDrop';

interface BoardCardProps {
  order: OrderListItem;
  column: BoardColumnKey;
  /** False for «done» and for a viewer who may not change orders — no handle is drawn at all. */
  draggable: boolean;
}

/**
 * One compact order on the kanban (spec workshop-order-views, rule 6). Every
 * figure is the server's. The card is dragged by its HANDLE only — the queue's
 * pattern — so a click (or Enter) on the card still opens the order: the link
 * is an overlay under the handle, as on `OrderCard`.
 */
export function BoardCard({ order, column, draggable }: BoardCardProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: order.id,
    data: { from: column, code: order.code },
    disabled: !draggable,
  });
  const overdue = isOverdue(order);
  const live = order.prints_in_progress > 0 || order.prints_queued > 0;

  return (
    <div
      ref={setNodeRef}
      data-testid={`board-card-${order.id}`}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={`relative rounded-lg bg-bambu-dark border border-bambu-dark-tertiary hover:border-bambu-green/50 p-3 space-y-1.5 ${
        isDragging ? 'z-40 shadow-xl opacity-90' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="block text-xs text-bambu-gray">{order.code}</span>
          <h4 className="text-sm font-semibold text-white truncate">{order.name}</h4>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <PriorityBadge priority={order.priority} />
          {draggable && (
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
        </div>
      </div>

      {order.customer_name && <p className="text-xs text-bambu-gray truncate">{order.customer_name}</p>}

      <ProgressBar
        value={order.covered_units}
        max={order.ordered}
        progress={order.progress}
        label={t('orders.card.covered')}
        testId={`board-card-${order.id}-progress`}
      />

      {order.due_date && (
        <p data-testid={`board-card-${order.id}-due`} className={`text-xs ${overdue ? 'text-red-500' : 'text-bambu-gray'}`}>
          {new Date(order.due_date).toLocaleDateString()}
        </p>
      )}

      {live && (
        <p className="text-xs text-bambu-gray">
          {t('orders.card.live', { printing: order.prints_in_progress, queued: order.prints_queued })}
        </p>
      )}

      {order.responsible_name && <ResponsibleName name={order.responsible_name} className="text-xs text-bambu-gray" />}

      <Link
        to={`/projects/${order.id}`}
        aria-label={order.name}
        className="absolute inset-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
      />
    </div>
  );
}
