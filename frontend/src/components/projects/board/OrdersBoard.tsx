import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { DndContext, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { Announcements, DragEndEvent } from '@dnd-kit/core';
import { api } from '../../../api/client';
import type { OrderBoard, OrderBoardColumn, OrderViewFilters } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { Button } from '../../Button';
import { ConfirmModal } from '../../ConfirmModal';
import { BoardCard } from './BoardCard';
import { BOARD_COLUMNS, boardKeyboardCoordinates } from './boardDrop';
import type { BoardColumnKey } from './boardDrop';
import { useBoardActions } from './useBoardActions';

interface OrdersBoardProps {
  filters: OrderViewFilters;
  /** «…and N more» leads to the TABLE — the view is the viewer's stored choice, not the URL's, so the page switches it. */
  onOpenList: () => void;
  /** The page's «Reset» — offered when the filters leave the whole board empty. */
  onReset?: () => void;
}

/** The list's URL for a column's overflow: its tab and stage, the shared filters kept, the place in the list dropped. */
function listHref(search: string, key: BoardColumnKey): string {
  const next = new URLSearchParams(search);
  for (const k of ['page', 'order', 'week', 'stage']) next.delete(k);
  next.set('tab', key === 'done' ? 'completed' : 'active');
  if (key !== 'done') next.set('stage', key);
  return `/projects?${next}`;
}

/**
 * The kanban (spec workshop-order-views, rules 5–8): one request for the whole
 * board, each column capped by the server with its `total` beside it. A drop
 * writes and re-reads; nothing is rearranged here.
 */
export function OrdersBoard({ filters, onOpenList, onReset }: OrdersBoardProps) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { search } = useLocation();
  const { data, isError, isPlaceholderData } = useQuery({
    // Under the `projects` prefix, so `invalidateOrderViews` re-reads the board too.
    queryKey: ['projects', 'board', filters],
    queryFn: () => api.getOrderBoard(filters),
    // The previous board stays while a new search or filter is asked — no flash of empty columns.
    placeholderData: keepPreviousData,
  });
  const { drop, confirming, completing, confirm, cancel } = useBoardActions();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: boardKeyboardCoordinates }),
  );
  const canMove = hasPermission('projects:update');
  const filtered = Object.values(filters).some((v) => v != null && v !== '');
  const nothing = data != null && !isPlaceholderData && BOARD_COLUMNS.every((key) => data[key].total === 0);

  const title = (key: BoardColumnKey) => t(`orders.stage.${key}`);
  const codeOf = (data: Record<string, unknown> | undefined) => String(data?.code ?? '');
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('orders.board.a11y.picked', { code: codeOf(active.data.current) }),
    onDragOver: ({ over }) =>
      over ? t('orders.board.a11y.over', { column: title(over.id as BoardColumnKey) }) : t('orders.board.a11y.nowhere'),
    onDragEnd: ({ active, over }) =>
      over
        ? t('orders.board.a11y.dropped', { code: codeOf(active.data.current), column: title(over.id as BoardColumnKey) })
        : t('orders.board.a11y.cancelled', { code: codeOf(active.data.current) }),
    onDragCancel: ({ active }) => t('orders.board.a11y.cancelled', { code: codeOf(active.data.current) }),
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const from = active.data.current?.from as BoardColumnKey | undefined;
    if (over && from) drop(Number(active.id), from, over.id as BoardColumnKey);
  };

  const confirmingOrder = confirming != null && data ? findOrder(data, confirming) : undefined;

  // A failed read with nothing to show is said out loud: four empty columns would read as «no orders».
  if (isError && !data) return <p className="text-sm text-red-500">{t('orders.board.loadFailed')}</p>;

  return (
    <>
      {filtered && nothing && (
        <div className="flex items-center gap-3 text-bambu-gray text-sm mb-3">
          <span>{t('list.empty.noMatch')}</span>
          {onReset && (
            <Button variant="secondary" onClick={onReset}>
              {t('list.empty.reset')}
            </Button>
          )}
        </div>
      )}
      <DndContext
        sensors={sensors}
        onDragEnd={onDragEnd}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t('orders.board.a11y.instructions') } }}
      >
        <div
          aria-busy={isPlaceholderData}
          className={`grid gap-3 md:grid-cols-2 xl:grid-cols-4 items-start transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}
        >
          {BOARD_COLUMNS.map((key) => (
            <BoardColumn
              key={key}
              columnKey={key}
              title={title(key)}
              column={data?.[key]}
              canDrag={canMove && key !== 'done'}
              canDrop={canMove}
              moreHref={listHref(search, key)}
              onOpenList={onOpenList}
            />
          ))}
        </div>
      </DndContext>

      {confirming != null && (
        <ConfirmModal
          title={t('orders.board.completeTitle')}
          message={t('orders.board.completeBody', { code: confirmingOrder?.code ?? '', name: confirmingOrder?.name ?? '' })}
          isLoading={completing}
          onConfirm={confirm}
          onCancel={cancel}
        />
      )}
    </>
  );
}

function findOrder(board: OrderBoard, id: number) {
  for (const key of BOARD_COLUMNS) {
    const found = board[key].items.find((o) => o.id === id);
    if (found) return found;
  }
  return undefined;
}

interface BoardColumnProps {
  columnKey: BoardColumnKey;
  title: string;
  column: OrderBoardColumn | undefined;
  /** Its cards carry a handle — never in «done», never without `projects:update`. */
  canDrag: boolean;
  /** A card may land here — every column, «done» included, for whoever may change orders. */
  canDrop: boolean;
  moreHref: string;
  onOpenList: () => void;
}

function BoardColumn({ columnKey, title, column, canDrag, canDrop, moreHref, onOpenList }: BoardColumnProps) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: columnKey, disabled: !canDrop });
  const items = column?.items ?? [];
  const more = (column?.total ?? 0) - items.length;
  const headingId = `board-column-${columnKey}`;

  return (
    <section
      ref={setNodeRef}
      data-board-column={columnKey}
      aria-labelledby={headingId}
      className={`rounded-xl border bg-bambu-dark-secondary p-3 space-y-2 ${
        isOver ? 'border-bambu-green' : 'border-bambu-dark-tertiary'
      }`}
    >
      <div className="flex items-center justify-between">
        <h3 id={headingId} className="text-sm font-semibold text-white">
          {title}
        </h3>
        <span data-testid={`board-total-${columnKey}`} className="text-xs text-bambu-gray tabular-nums">
          {/* «…» until the first answer: a 0 would claim an empty column. */}
          {column?.total ?? '…'}
        </span>
      </div>
      {column && items.length === 0 && (
        <p className="text-xs text-bambu-gray py-6 text-center border border-dashed border-bambu-dark-tertiary rounded-lg">
          {t(canDrop ? 'orders.board.empty' : 'orders.board.none')}
        </p>
      )}
      {items.map((order) => (
        <BoardCard key={order.id} order={order} column={columnKey} draggable={canDrag} />
      ))}
      {more > 0 && (
        <Link to={moreHref} onClick={onOpenList} className="block text-xs text-bambu-green hover:underline">
          {t('orders.board.more', { count: more })}
        </Link>
      )}
    </section>
  );
}
