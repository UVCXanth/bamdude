import type { OrderRef } from './orderRef';

/** Every action an order offers (WS-13 E6 B02). `open` and `cover` belong to one context each. */
export type OrderAction =
  | 'open'
  | 'edit'
  | 'duplicate'
  | 'fulfil'
  | 'bank'
  | 'complete'
  | 'cancel'
  | 'reopen'
  | 'cover'
  | 'delete';

export interface OrderMenuItem {
  action: OrderAction;
  danger?: boolean;
  /** A line above the item — only `delete`, and only when something is above it. */
  separatorBefore?: boolean;
}

export interface OrderMenuRights {
  update: boolean;
  create: boolean;
  remove: boolean;
  /** `orders:update` + `stock:move` — issuing and banking move the shelf (WS-13 E13 O06). */
  issue: boolean;
}

/**
 * The order's menu, in order, with its gates (WS-13 E6 B02) — the same in the order
 * page, the workspace pane, the cards of the orders and customer pages. A gated item
 * is left out, never shown disabled (the mockup's `menu` filters the same way).
 *
 * - `open` — a list only, and only beside another allowed action: a reader gets no
 *   menu, the card itself is the link (R06).
 * - `bank` — whatever the status, as the server banks it; only while there is some.
 * - `cover` — the detail only (its dialog needs the full order, E3-C05).
 */
export function orderMenuItems(
  order: Pick<OrderRef, 'status' | 'bankable_surplus'>,
  can: OrderMenuRights,
  context: 'detail' | 'list',
): OrderMenuItem[] {
  const active = order.status === 'active';
  const items: OrderMenuItem[] = [];
  if (can.update) items.push({ action: 'edit' });
  if (can.create) items.push({ action: 'duplicate' });
  if (can.issue && active) items.push({ action: 'fulfil' });
  if (can.issue && order.bankable_surplus > 0) items.push({ action: 'bank' });
  if (can.update && active) items.push({ action: 'complete' }, { action: 'cancel' });
  if (can.update && !active) items.push({ action: 'reopen' });
  if (can.update && context === 'detail') items.push({ action: 'cover' });
  if (context === 'list' && (items.length > 0 || can.remove)) items.unshift({ action: 'open' });
  if (can.remove) items.push({ action: 'delete', danger: true, separatorBefore: items.length > 0 });
  return items;
}
