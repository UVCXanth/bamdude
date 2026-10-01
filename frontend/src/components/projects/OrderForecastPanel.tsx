import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { formatDateTime } from '../../utils/date';
import { hoursMinutes } from '../../utils/forecast';
import { Button } from '../Button';
import { WorkshopPanel } from '../workshop/WorkshopPanel';
import type { ForecastView } from './orderForecastView';

/**
 * «Forecast» — the order page's side panel, active orders only (WS-13 E3 G02):
 * when the order is ready if queued now and after the orders ahead, the machine
 * hours per printer model, and why the estimate is incomplete.
 *
 * ⚠️ **One decision with the «Ready ≈» tile** (`forecastView`): while the plan
 * has a draft — and between a successful send and the fresh forecast — nothing
 * numeric is shown; the previous plan's ETA read as current is exactly what
 * this panel must never do (R03).
 *
 * ⚠️ **Printers and prints are two numbers** (R06): a model row names the
 * machines that take work (`accepting_printers`) and the plate runs apart;
 * none taking work is «no printers taking work», not «no printer» — the
 * machines may exist and stand paused.
 */
export function OrderForecastPanel({
  view,
  remaining,
  onRetry,
  headingLevel = 2,
}: {
  view: ForecastView;
  remaining: number;
  onRetry: () => void;
  headingLevel?: 2 | 3;
}) {
  const { t } = useTranslation();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });

  const body = () => {
    if (remaining === 0) return <p className="text-sm text-bambu-green">{t('orders.forecast.allCovered')}</p>;
    if (view.kind === 'draft') return <p className="text-sm text-bambu-gray-light">{t('orders.plan.forecastStale')}</p>;
    if (view.kind === 'closed') return null;
    if (view.kind === 'loading') return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;
    if (view.kind === 'error') {
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm text-red-400">
          <span>{t('farmForecast.error')}</span>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </div>
      );
    }

    const f = view.forecast;
    const when = (iso: string | null) =>
      formatDateTime(iso, settings?.time_format, settings?.date_format, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return (
      <div className="space-y-2 text-sm">
        {view.refreshFailed && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
            {t('orders.detail.refreshFailed')}
            <button type="button" onClick={onRetry} className="text-bambu-green hover:underline">
              {t('common.retry')}
            </button>
          </p>
        )}
        {f.now_eta ? (
          <div>
            <div
              data-testid="order-forecast-eta"
              data-tone={f.late ? 'late' : undefined}
              className={`text-xl leading-7 font-semibold ${f.late ? 'text-red-500' : 'text-bambu-green'}`}
            >
              {when(f.now_eta)}
            </div>
            <small className="block text-xs text-bambu-gray">
              {t('orders.forecast.ifNow')}
              {f.late && (
                <>
                  {' — '}
                  <b className="font-semibold text-red-500">{t('orders.forecast.late')}</b>
                </>
              )}
            </small>
            {f.ahead_count > 0 && f.after_eta && f.after_eta !== f.now_eta && (
              <small className="mt-2 block text-xs text-bambu-gray">
                {t('orders.figures.afterAhead', { count: f.ahead_count, when: when(f.after_eta) })}
              </small>
            )}
          </div>
        ) : (
          <p className="text-bambu-gray">{t('orders.forecast.noEstimate')}</p>
        )}

        <dl className="grid grid-cols-[1fr_auto] gap-x-3.5 gap-y-1.5 text-bambu-gray-light">
          <div className="contents">
            <dt>{t('orders.forecast.machineHours')}</dt>
            <dd className="text-right font-medium text-white tabular-nums">{hoursMinutes(f.machine_seconds)}</dd>
          </div>
          {f.by_model.map((m, index) => (
            <div key={`${m.model ?? ''}-${index}`} data-testid="order-forecast-model" className="contents">
              <dt>
                {m.model ?? t('orders.forecast.noModel')}
                {m.accepting_printers > 0 && ` (${t('orders.forecast.printers', { count: m.accepting_printers })})`}
                {' · '}
                {t('orders.forecast.prints', { count: m.prints })}
                {m.accepting_printers === 0 && (
                  <span className="block text-xs text-amber-700 dark:text-amber-400">{t('orders.forecast.noPrinters')}</span>
                )}
              </dt>
              <dd className="text-right font-medium text-white tabular-nums">{hoursMinutes(m.seconds)}</dd>
            </div>
          ))}
        </dl>

        {f.incomplete_reasons.map((reason) => (
          <small key={reason.code} data-testid="order-forecast-reason" className="block text-xs text-amber-700 dark:text-amber-400">
            {t(`projects.estimateReasons.${reason.code}`)}
            {reason.count != null && `: ${reason.count}`}
          </small>
        ))}

        <p className="text-xs leading-[18px] text-bambu-gray">
          {t('orders.forecast.approximate')}
          {f.assumptions.length > 0 &&
            `: ${f.assumptions.map((code) => t(`farmForecast.assumptions.${code}`, { defaultValue: code })).join(', ')}`}
        </p>
      </div>
    );
  };

  return (
    <WorkshopPanel data-testid="order-forecast-panel" title={t('orders.forecast.title')} headingLevel={headingLevel}>
      {body()}
    </WorkshopPanel>
  );
}
