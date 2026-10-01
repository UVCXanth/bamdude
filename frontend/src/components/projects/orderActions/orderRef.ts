import type { Order, OrderListItem, ProjectStatus } from '../../../api/client';

/**
 * What the order action model needs to know about an order (WS-13 E6 B06): enough to
 * gate the menu and to title every dialog it opens. A list row and the full detail
 * both make one — the dialogs read the rest themselves.
 */
export interface OrderRef {
  id: number;
  code: string;
  name: string;
  status: ProjectStatus;
  customer_name: string | null;
  bankable_surplus: number;
  due_date: string | null;
}

/** The full detail rather than a list row — the one test the action model asks. */
export function isOrderDetail(order: Order | OrderListItem | null | undefined): order is Order {
  return order != null && 'figures' in order;
}

/**
 * The one way to make an `OrderRef`. ⚠️ The detail carries its bankable surplus in
 * `figures` — it has no top-level field — while a list row carries it on the row
 * (E6 H02); reading `order.bankable_surplus` off a detail would be `undefined`.
 */
export function toOrderRef(order: Order | OrderListItem): OrderRef {
  return {
    id: order.id,
    code: order.code,
    name: order.name,
    status: order.status,
    customer_name: order.customer_name,
    due_date: order.due_date,
    bankable_surplus: isOrderDetail(order) ? order.figures.bankable_surplus : (order.bankable_surplus ?? 0),
  };
}
