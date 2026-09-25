import { useTranslation } from 'react-i18next';
import { useStockFigures } from '../../hooks/useStock';
import { StatTile, StatTiles } from '../StatTile';

/**
 * The stock page's four tiles over the free-parts ledger (spec workshop-lists,
 * rule 16) — the whole shelf, never the list's filters. WS-09 replaces them
 * with finished goods.
 */
export function StockTiles() {
  const { t } = useTranslation();
  const { data, isError } = useStockFigures();
  const failed = isError && !data;
  return (
    <StatTiles>
      <StatTile
        testId="stock-tile-kits"
        label={t('stock.tiles.kits')}
        value={data?.kits}
        failed={failed}
        sub={data ? t('stock.tiles.kitsSub', { count: data.kit_products }) : undefined}
      />
      <StatTile
        testId="stock-tile-parts"
        label={t('stock.tiles.parts')}
        value={data?.parts}
        failed={failed}
        sub={t('stock.tiles.partsSub')}
      />
      <StatTile
        testId="stock-tile-reserved"
        label={t('stock.tiles.reserved')}
        value={data?.reserved_kits}
        failed={failed}
        sub={t('stock.tiles.reservedSub')}
      />
      <StatTile
        testId="stock-tile-incomplete"
        label={t('stock.tiles.incomplete')}
        value={data?.incomplete}
        failed={failed}
        tone={data && data.incomplete > 0 ? 'warn' : undefined}
        sub={t('stock.tiles.incompleteSub')}
      />
    </StatTiles>
  );
}
