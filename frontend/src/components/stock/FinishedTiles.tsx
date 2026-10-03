import { useTranslation } from 'react-i18next';
import { useStockItemsSummary } from '../../hooks/useFinishedStock';
import { StatTile, StatTiles } from '../StatTile';

/**
 * The finished-goods tiles (spec workshop-finished-goods, rule 17) — the whole
 * farm, never the list's filters. Five server figures on four tiles: the
 * count of positions on record rides under the stock on hand. They stand over
 * every tab of the stock page, in the mockup's words (WS-13 E12 B02).
 */
export function FinishedTiles() {
  const { t } = useTranslation();
  const { data, isError } = useStockItemsSummary();
  const failed = isError && !data;
  return (
    <StatTiles>
      <StatTile
        testId="finished-tile-on-hand"
        label={t('stock.finished.tiles.onHand')}
        value={data?.on_hand}
        failed={failed}
        sub={data ? t('stock.finished.tiles.onHandSub', { count: data.tracked }) : undefined}
      />
      <StatTile
        testId="finished-tile-reserved"
        label={t('stock.finished.tiles.reserved')}
        value={data?.reserved}
        failed={failed}
        sub={t('stock.finished.tiles.reservedSub')}
      />
      <StatTile
        testId="finished-tile-available"
        label={t('stock.finished.tiles.available')}
        value={data?.available}
        failed={failed}
        sub={t('stock.finished.tiles.availableSub')}
      />
      <StatTile
        testId="finished-tile-below-min"
        label={t('stock.finished.tiles.belowMin')}
        value={data?.below_min}
        failed={failed}
        tone={data && data.below_min > 0 ? 'warn' : undefined}
        sub={t('stock.finished.tiles.belowMinSub')}
      />
    </StatTiles>
  );
}
