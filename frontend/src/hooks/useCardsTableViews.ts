import { LayoutGrid, Table } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ListView, ListViewOption } from '../components/ListViewToggle';
import { CARDS_TABLE_MODES } from './usePersistedState';

/** Every mode needs its icon — a `Record` over the mode type makes a missing one a type error. */
const ICONS: Record<ListView, LucideIcon> = { cards: LayoutGrid, table: Table };

/** «Cards / Table» — the two modes every Workshop list has today (WS-05 adds more to orders). */
export function useCardsTableViews(): ListViewOption<ListView>[] {
  const { t } = useTranslation();
  return CARDS_TABLE_MODES.map((value) => ({ value, icon: ICONS[value], label: t(`list.view.${value}`) }));
}
