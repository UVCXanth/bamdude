import { CalendarDays, LayoutGrid, PanelLeft, SquareKanban, Table } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ListViewOption } from '../components/ListViewToggle';
import { ORDERS_VIEW_MODES } from './usePersistedState';
import type { OrdersView } from './usePersistedState';

/** Every mode needs its icon — a `Record` over the mode type makes a missing one a type error. */
const ICONS: Record<OrdersView, LucideIcon> = {
  table: Table,
  cards: LayoutGrid,
  kanban: SquareKanban,
  workspace: PanelLeft,
  deadlines: CalendarDays,
};

/** The orders page's five views (spec workshop-order-views, rule 1). */
export function useOrdersViews(): ListViewOption<OrdersView>[] {
  const { t } = useTranslation();
  return ORDERS_VIEW_MODES.map((value) => ({ value, icon: ICONS[value], label: t(`orders.view.${value}`) }));
}
