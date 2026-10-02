import { useTranslation } from 'react-i18next';
import { etaFull } from '../../../utils/forecast';
import { ForecastHint } from '../ForecastHint';
import { EstimateWarning } from './EstimateWarning';
import type { Readiness } from './readiness';
import { etaLabel, useDateSettings } from './useDateSettings';

/**
 * «Ready ≈» of one order in a list (WS-13 E7 B03) — the table's column and the
 * card's meta cell. What to say is decided by `readiness`; this only draws it.
 * Unknown is never «no estimate» and never a zero.
 */
/** The assumptions' hint (B03, Codex r1 V04) — above a card's overlay link, so the mouse reaches it. */
const HINT = 'relative z-10 ml-1';

export function ReadyEstimate({ readiness, testId = 'ready-estimate' }: { readiness: Readiness; testId?: string }) {
  const { t } = useTranslation();
  const { dateFormat, timeFormat } = useDateSettings();

  switch (readiness.kind) {
    case 'closed':
      return <span data-testid={testId} className="text-bambu-gray">—</span>;
    case 'covered':
      return <span data-testid={testId} className="text-bambu-green">{t('orders.row.allCovered')}</span>;
    case 'loading':
      return (
        <span data-testid={testId} aria-busy="true" className="text-bambu-gray">
          …<span className="sr-only">{t('common.loading')}</span>
        </span>
      );
    case 'error':
      return (
        <span data-testid={testId} className="text-bambu-gray">
          <span title={t('orders.row.forecastNotRead')} className="relative z-10">—</span>
        </span>
      );
    case 'partial':
      return (
        <span data-testid={testId} className="inline-flex items-center text-amber-700 dark:text-amber-400">
          {t('orders.row.incomplete')}
          <EstimateWarning reasons={readiness.reasons} />
          <ForecastHint forecast={readiness} className={HINT} />
        </span>
      );
    case 'none':
      return <span data-testid={testId} className="text-bambu-gray">{t('orders.row.noEstimate')}</span>;
    case 'eta':
      return (
        <span data-testid={testId} className="block">
          <span className="inline-flex items-center">
            <span
              data-late={readiness.late ? 'true' : undefined}
              title={etaFull(readiness.eta, timeFormat, dateFormat)}
              className={`relative z-10 tabular-nums ${readiness.late ? 'text-red-600 dark:text-red-500' : 'text-white'}`}
            >
              {etaLabel(readiness.eta, dateFormat)}
              {readiness.late && <span className="sr-only"> ({t('orders.forecast.late')})</span>}
            </span>
            <EstimateWarning reasons={readiness.reasons} />
            <ForecastHint forecast={readiness} className={HINT} />
          </span>
          {readiness.after && (
            <span className="block text-xs text-bambu-gray">
              {t('orders.figures.afterAhead', { count: readiness.after.ahead, when: etaLabel(readiness.after.eta, dateFormat) })}
            </span>
          )}
        </span>
      );
  }
}
