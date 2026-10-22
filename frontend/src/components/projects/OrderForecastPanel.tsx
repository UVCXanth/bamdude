import { useTranslation } from 'react-i18next';
import { formatDateTime, formatDuration } from '../../utils/date';
import { hoursMinutes } from '../../utils/forecast';
import { Button } from '../Button';
import { WorkshopPanel } from '../workshop/WorkshopPanel';
import type { ForecastView } from './orderForecastView';
import { useUiPreferences } from '../../hooks/useUiPreferences';
import type { DraftForecastState } from '../../hooks/useDraftForecast';

/**
 * «Forecast» — the order page's side panel, active orders only (WS-13 E3 G02):
 * when the order is ready if queued now and after the orders ahead, the machine
 * hours per printer model, and why the estimate is incomplete.
 *
 * The editor supplies its exact draft result. Legacy consumers retain the
 * conservative forecastView states; a date from another plan is never current.
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
  draft,
}: {
  view: ForecastView;
  remaining: number;
  onRetry: () => void;
  headingLevel?: 2 | 3;
  draft?: DraftForecastState;
}) {
  const { t } = useTranslation();
  const { data: settings } = useUiPreferences();

  if (draft?.planLoading || draft?.nothingToPlan) return null;

  const body = () => {
    if (draft) return <DraftForecastBody draft={draft} />;
    if (remaining === 0) return <p className="text-sm text-bambu-green">{t('orders.forecast.allCovered')}</p>;
    if (view.kind === 'draft') return <p className="text-sm text-bambu-gray-light">{t('orders.plan.forecastStale')}</p>;
    if (view.kind === 'closed') return null;
    if (view.kind === 'loading') return <p className="text-sm text-bambu-gray">{t('common.loading')}</p>;
    if (view.kind === 'error') {
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm text-red-600 dark:text-red-400">
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
            {f.now_seconds != null && (
              <p className="mb-2 text-base font-semibold text-white" data-testid="order-forecast-duration">
                {t('orders.forecast.elapsedDuration')}: {formatDuration(f.now_seconds)}
              </p>
            )}
            <div
              data-testid="order-forecast-eta"
              data-tone={f.late ? 'late' : undefined}
              className={`text-xl leading-7 font-semibold ${f.late ? 'text-red-600 dark:text-red-500' : 'text-bambu-green'}`}
            >
              {when(f.now_eta)}
            </div>
            <small className="block text-xs text-bambu-gray">
              {t('orders.forecast.ifNow')}
              {f.late && (
                <>
                  {' — '}
                  <b className="font-semibold text-red-600 dark:text-red-500">{t('orders.forecast.late')}</b>
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

function DraftForecastBody({ draft }: { draft: DraftForecastState }) {
  const { t } = useTranslation();
  const { data: settings } = useUiPreferences();
  if (draft.invalid) return <p className="text-sm text-amber-600">{t('orderDraft.invalid')}</p>;
  const result = draft.result;
  const when = (value: string) => formatDateTime(value, settings?.time_format, settings?.date_format);
  const delta = result?.comparison.machine_seconds_delta;
  return <div className="space-y-3 text-sm" data-testid="draft-forecast">
    {draft.pending && <p className="text-bambu-gray" role="status">{t('orderDraft.updating')}</p>}
    {draft.error && <p className="text-red-600 dark:text-red-500">{t('farmForecast.error')} <Button size="sm" onClick={draft.retry}>{t('common.retry')}</Button></p>}
    {result && <>
      <div>
        <p className="text-bambu-gray-light">{t('orderDraft.machineHours')}</p>
        <p className="text-2xl font-semibold text-white tabular-nums" data-testid="draft-machine-hours">
          {hoursMinutes(result.workload.total_seconds)}
        </p>
        {result.workload.unknown_prints > 0 && <p className="text-amber-600 dark:text-amber-400">
          {t('orderDraft.knownTime', { time: hoursMinutes(result.workload.known_seconds), count: result.workload.unknown_prints })}
        </p>}
        {delta != null ? <p data-testid="draft-hours-delta">
          {delta === 0 ? t('orderDraft.same') : t(delta < 0 ? 'orderDraft.less' : 'orderDraft.more', {
            time: Math.abs(delta) < 60 ? t('orderDraft.lessThanMinute') : formatDuration(Math.abs(delta)),
          })}
        </p> : <p className="text-xs text-bambu-gray">{t(`orderDraft.comparison.${result.comparison.status}`, { defaultValue: t('orderDraft.comparison.unavailable') })}</p>}
        {result.comparison.coverage_changed && <p className="text-amber-600 dark:text-amber-400">{t('orderDraft.coverageChanged')}</p>}
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-2">
        {result.workload.by_model.map(m => <div className="contents" key={m.model ?? 'unknown'}>
          <dt>{m.model ?? t('orders.forecast.noModel')} · {t('orders.forecast.prints', { count: m.prints })}</dt>
          <dd className="tabular-nums">{hoursMinutes(m.total_seconds)}</dd>
        </div>)}
      </dl>
      {!result.coverage_complete && <p className="text-amber-600 dark:text-amber-400" data-testid="draft-unplanned">
        {t('orderDraft.unplanned', { count: result.coverage.reduce((n, p) => n + p.missing, 0) })}
      </p>}
      {result.issues.length > 0 && <p className="text-amber-600 dark:text-amber-400">{t('orderDraft.sourceIssues', { count: result.issues.length })}</p>}
      <div className="border-t border-bambu-dark-tertiary pt-2">
        <p className="text-xs text-bambu-gray">{t(result.coverage_complete ? 'orderDraft.orderDate' : 'orderDraft.selectedDate')}</p>
        {result.forecast?.now_eta ? <>
          <p className={`font-medium ${result.forecast.late ? 'text-red-600 dark:text-red-500' : 'text-white'}`}
            data-testid="order-forecast-eta">{when(result.forecast.now_eta)}</p>
          {!result.forecast.eta_complete && <p className="text-amber-600 dark:text-amber-400">{t('orderDraft.incompleteDate')}</p>}
          {result.comparison.now_seconds_delta != null && <p className="text-xs text-bambu-gray-light" data-testid="draft-date-delta">
            {result.comparison.now_seconds_delta === 0 ? t('workingPlan.dateSame') : t(result.comparison.now_seconds_delta < 0 ? 'workingPlan.dateSooner' : 'workingPlan.dateLater', {
              time: Math.abs(result.comparison.now_seconds_delta) < 60 ? t('orderDraft.lessThanMinute') : formatDuration(Math.abs(result.comparison.now_seconds_delta)),
            })}
          </p>}
          {result.forecast.ahead_count > 0 && result.forecast.after_eta && <p className="text-xs text-bambu-gray">
            {t('orders.figures.afterAhead', { count: result.forecast.ahead_count, when: when(result.forecast.after_eta) })}
          </p>}
        </> : <p className="text-bambu-gray">{t('orders.forecast.noEstimate')}</p>}
        {result.forecast_error && <button type="button" className="text-bambu-green" onClick={draft.retry}>{t('common.retry')}</button>}
      </div>
      {result.forecast && <>
        {result.forecast.incomplete_reasons.filter(reason => reason.code !== 'unplanned_parts').map(reason =>
          <p key={reason.code} className="text-xs text-amber-600 dark:text-amber-400">
            {t(`projects.estimateReasons.${reason.code}`)}{reason.count != null && `: ${reason.count}`}
          </p>)}
        {result.forecast.assumptions.length > 0 && <p className="text-xs text-bambu-gray">
          {t('orders.forecast.approximate')}: {result.forecast.assumptions.map(code => t(`farmForecast.assumptions.${code}`, { defaultValue: code })).join(', ')}
        </p>}
      </>}
      <p className="text-xs text-bambu-gray">{t('orderDraft.nominalHint')}</p>
    </>}
  </div>;
}
