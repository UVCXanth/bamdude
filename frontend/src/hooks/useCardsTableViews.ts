import { LayoutGrid, Table } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ListView, ListViewOption } from '../components/ListViewToggle';

/** «Cards / Table» — the two modes every Workshop list has today (WS-05 adds more to orders). */
export function useCardsTableViews(): ListViewOption<ListView>[] {
  const { t } = useTranslation();
  return [
    { value: 'cards', icon: LayoutGrid, label: t('list.view.cards') },
    { value: 'table', icon: Table, label: t('list.view.table') },
  ];
}
