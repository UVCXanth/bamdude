import type { ProjectStatus } from '../../api/client';

/** The status tabs of an order list, in their order. */
export const ORDER_TABS: readonly (ProjectStatus | 'all')[] = ['active', 'completed', 'cancelled', 'all'];

/** Each view has its own default order (owner's ruling): the table is the
 *  deadline roll-up it always was, the cards are "what moved lately", the
 *  workspace lists like the table. The board and the deadlines order
 *  themselves on the server and never read it — the entries only give the URL
 *  state a default in every view. An explicit `?sort=` applies to all. */
export const ORDERS_DEFAULT_SORT = {
  table: 'due-asc',
  cards: 'updated-desc',
  workspace: 'due-asc',
  kanban: 'updated-desc',
  deadlines: 'updated-desc',
} as const;
