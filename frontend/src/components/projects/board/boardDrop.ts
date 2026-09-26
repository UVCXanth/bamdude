import type { KeyboardCoordinateGetter } from '@dnd-kit/core';
import type { OrderStage } from '../../../api/client';

export type BoardColumnKey = OrderStage | 'done';
export const BOARD_COLUMNS: readonly BoardColumnKey[] = ['prep', 'printing', 'qc', 'done'];

/**
 * What dropping a card does (spec workshop-order-views, rule 7): into an active
 * column — set that stage; into «done» — complete the order (after a
 * confirmation); into its own column, or a «done» card anywhere — nothing.
 */
export function resolveDrop(
  from: BoardColumnKey,
  to: BoardColumnKey,
): { kind: 'stage'; stage: OrderStage } | { kind: 'complete' } | null {
  if (from === to || from === 'done') return null;
  if (to === 'done') return { kind: 'complete' };
  return { kind: 'stage', stage: to };
}

const NEXT_KEYS = ['ArrowRight', 'ArrowDown'];
const PREV_KEYS = ['ArrowLeft', 'ArrowUp'];

/**
 * Keyboard moves between COLUMNS, not by pixels: an arrow puts the lifted card
 * over the next (→ ↓) or the previous (← ↑) column in board order, whatever the
 * layout wraps them into. `sortableKeyboardCoordinates` does not fit — it needs
 * the dragged item to be a droppable of its own, and a board card is not.
 */
export const boardKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const step = NEXT_KEYS.includes(event.code) ? 1 : PREV_KEYS.includes(event.code) ? -1 : 0;
  if (step === 0) return undefined;
  event.preventDefault();
  const { active, over, collisionRect, droppableRects } = context;
  if (!active || !collisionRect) return undefined;
  const here = (over?.id ?? active.data.current?.from) as BoardColumnKey | undefined;
  const next = here ? BOARD_COLUMNS[BOARD_COLUMNS.indexOf(here) + step] : undefined;
  const rect = next ? droppableRects.get(next) : undefined;
  if (!rect) return undefined;
  return { x: rect.left + Math.max(0, (rect.width - collisionRect.width) / 2), y: rect.top };
};
