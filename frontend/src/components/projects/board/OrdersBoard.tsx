import { useEffect, useRef } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { DndContext, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { Announcements, DragEndEvent } from '@dnd-kit/core';
import { api } from '../../../api/client';
import type { OrderBoardColumn, OrderStage, OrderViewFilters } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { Button } from '../../Button';
import { LoadFailedNote } from '../../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../../workshop/RefreshFailedNote';
import { toOrderRef } from '../orderActions/orderRef';
import type { OrderActions } from '../orderActions/useOrderActions';
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
  /** The page's order action host (WS-13 E6 B01) — a drop onto «done» is its «complete» door. */
  actions: OrderActions;
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
export function OrdersBoard({ filters, onOpenList, onReset, actions }: OrdersBoardProps) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { search } = useLocation();
  const { data, isError, isPlaceholderData, refetch } = useQuery({
    // Under the `projects` prefix, so `invalidateOrderViews` re-reads the board too.
    queryKey: ['projects', 'board', filters],
    queryFn: () => api.getOrderBoard(filters),
    // The previous board stays while a new search or filter is asked — no flash of empty columns.
    placeholderData: keepPreviousData,
  });
  const { drop, setStage, pendingIds } = useBoardActions((orderId) => {
    const order = BOARD_COLUMNS.flatMap((key) => data?.[key].items ?? []).find((o) => o.id === orderId);
    if (order) actions.run('complete', toOrderRef(order));
  });
  // F07 (final review): a stage write moves the card to another column — a NEW element — once the
  // board is read again, and the focus the operator left on it would fall to the page. The door
  // it was moved through is remembered and focused again on the card's new element, unless the
  // operator has moved on meanwhile.
  const refocus = useRef<{ id: number; part: 'stage' | 'handle' } | null>(null);
  useEffect(() => {
    const want = refocus.current;
    if (!want || pendingIds.has(want.id)) return;
    refocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.querySelector<HTMLElement>(`[data-testid="board-card-${want.id}-${want.part}"]`)?.focus();
  }, [data, pendingIds]);
  const stageFromMenu = (orderId: number, stage: OrderStage) => {
    refocus.current = { id: orderId, part: 'stage' };
    setStage(orderId, stage);
  };
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
    if (over && from) {
      refocus.current = { id: Number(active.id), part: 'handle' };
      drop(Number(active.id), from, over.id as BoardColumnKey);
    }
  };

  // A failed read with nothing to show is said out loud: four empty columns would read as «no orders».
  if (isError && !data) return <LoadFailedNote message={t('orders.board.loadFailed')} onRetry={() => refetch()} />;

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
      {isError && data && <RefreshFailedNote onRetry={() => void refetch()} />}
      <DndContext
        sensors={sensors}
        onDragEnd={onDragEnd}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t('orders.board.a11y.instructions') } }}
      >
        {/* WS-13 E7 F01 (R08): four columns, always, min 240 — ONE horizontal scroll for the
            board (focusable and named, like a table's), the columns growing down. */}
        <div
          role="region"
          aria-label={t('orders.board.label')}
          tabIndex={0}
          aria-busy={isPlaceholderData}
          className={`relative grid grid-cols-[repeat(4,minmax(240px,1fr))] gap-3 items-start overflow-x-auto pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green rounded-xl transition-opacity ${isPlaceholderData ? 'opacity-60' : ''}`}
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
              actions={actions}
              pendingIds={pendingIds}
              onStage={stageFromMenu}
            />
          ))}
        </div>
      </DndContext>
      <p data-testid="orders-board-hint" className="mt-3 text-xs text-bambu-gray">
        {canMove ? t('orders.board.hint') : t('orders.board.hintReader')}
      </p>

    </>
  );
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
  actions: OrderActions;
  /** Cards whose stage is being written (WS-13 E7 F05). */
  pendingIds: ReadonlySet<number>;
  onStage: (orderId: number, stage: OrderStage) => void;
}

function BoardColumn({ columnKey, title, column, canDrag, canDrop, moreHref, onOpenList, actions, pendingIds, onStage }: BoardColumnProps) {
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
      className={`min-h-[420px] rounded-xl border p-3 space-y-2.5 transition-colors ${
        isOver ? 'border-bambu-green bg-bambu-green/[0.08]' : 'border-bambu-dark-tertiary bg-bambu-dark-secondary/55'
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
        <BoardCard
          key={order.id}
          order={order}
          column={columnKey}
          draggable={canDrag}
          actions={actions}
          pending={pendingIds.has(order.id)}
          onStage={(stage) => onStage(order.id, stage)}
        />
      ))}
      {more > 0 && (
        <Link to={moreHref} onClick={onOpenList} className="block text-xs text-bambu-green hover:underline">
          {t(columnKey === 'done' ? 'orders.board.moreDone' : 'orders.board.more', { count: more })}
        </Link>
      )}
    </section>
  );
}
