/**
 * The order's forecast and filament side panels (WS-13 E3 §G). Both say what
 * they KNOW: a draft plan hides the previous plan's numbers (R03), an unknown
 * weight or an unread shelf never turns into «enough» or «no need» (R02), and a
 * failed or cold read is told apart from an empty answer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { NeedRow } from '../../../api/client';
import { OrderForecastPanel } from '../../../components/projects/OrderForecastPanel';
import { OrderFilamentPanel } from '../../../components/projects/OrderFilamentPanel';
import type { ForecastView } from '../../../components/projects/orderForecastView';
import { makeForecast, makeNeeds } from '../../fixtures/orderDetail';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'getSettings').mockResolvedValue({ currency: 'USD', date_format: 'system', time_format: '24h' } as never);
});

const withData = (over = {}, refreshFailed = false): ForecastView => ({ kind: 'data', forecast: makeForecast(over), refreshFailed });

function forecast(view: ForecastView, { remaining = 3, onRetry = () => {} } = {}) {
  return render(<OrderForecastPanel view={view} remaining={remaining} onRetry={onRetry} />);
}

describe('OrderForecastPanel', () => {
  const panel = () => screen.getByTestId('order-forecast-panel');

  it('says there is nothing to print when everything is covered', () => {
    forecast(withData(), { remaining: 0 });
    expect(panel()).toHaveTextContent('Everything is covered — nothing to print.');
    expect(panel()).not.toHaveTextContent('Machine hours');
  });

  it('shows the ETA, what it assumes, what comes after the orders ahead, and the machine hours', () => {
    forecast(withData({ ahead_count: 1, machine_seconds: 108_840, assumptions: ['drying'] }));
    expect(panel()).toHaveTextContent('if queued now');
    expect(panel()).toHaveTextContent(/after 1 more urgent order/);
    expect(panel()).toHaveTextContent('Machine hours30:14');
    expect(panel()).toHaveTextContent('Approximate estimate: drying between prints');
  });

  it('reds a forecast past the deadline and says so in words', () => {
    forecast(withData({ late: true }));
    expect(screen.getByTestId('order-forecast-eta')).toHaveAttribute('data-tone', 'late');
    expect(panel()).toHaveTextContent('later than the deadline');
  });

  it('names printers and prints apart in each model row, and a model nothing takes (R06)', () => {
    forecast(
      withData({
        by_model: [
          { model: 'P1S', prints: 12, seconds: 7200, accepting_printers: 6 },
          { model: 'X1C', prints: 2, seconds: null, accepting_printers: 0 },
        ],
      }),
    );
    const rows = screen.getAllByTestId('order-forecast-model');
    expect(rows[0]).toHaveTextContent('P1S (6 printers) · 12 prints2:00');
    expect(rows[1]).toHaveTextContent('X1C · 2 prints');
    expect(rows[1]).toHaveTextContent('no printers taking work');
    expect(rows[1]).toHaveTextContent('—');
  });

  it('lists why the estimate is incomplete', () => {
    forecast(withData({ incomplete_reasons: [{ code: 'no_plate', count: 3 }, { code: 'truncated', count: null }] }));
    const reasons = screen.getAllByTestId('order-forecast-reason');
    expect(reasons.map((r) => r.textContent)).toEqual(['Parts on no plate: 3', 'The plan is too long to show whole']);
  });

  it('says «no estimate» without a date', () => {
    forecast(withData({ now_eta: null, after_eta: null }));
    expect(panel()).toHaveTextContent('No estimate');
    expect(panel()).not.toHaveTextContent('if queued now');
  });

  it('shows nothing numeric while the plan has a draft (R03)', () => {
    forecast({ kind: 'draft' });
    expect(panel()).toHaveTextContent(/previous plan/);
    expect(panel()).not.toHaveTextContent('Machine hours');
    expect(screen.queryByTestId('order-forecast-eta')).toBeNull();
    expect(screen.queryByTestId('order-forecast-model')).toBeNull();
  });

  it('waits, fails with a retry, and keeps a cached answer through a failed refresh', () => {
    const onRetry = vi.fn();
    const { unmount } = forecast({ kind: 'loading' }, { onRetry });
    expect(panel()).toHaveTextContent('Loading...');
    unmount();

    const again = forecast({ kind: 'error' }, { onRetry });
    fireEvent.click(within(screen.getByTestId('order-forecast-panel')).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    again.unmount();

    forecast(withData({}, true), { onRetry });
    expect(panel()).toHaveTextContent('Machine hours');
    expect(panel()).toHaveTextContent('Could not refresh');
  });
});

const need = (over: Partial<NeedRow>): NeedRow => ({
  material: 'PETG',
  colour: null,
  need_g: 2000,
  have_g: 4200,
  have_type_g: null,
  short_g: 0,
  unknown_prints: 0,
  ...over,
});

describe('OrderFilamentPanel', () => {
  const panel = () => screen.getByTestId('order-filament-panel');
  const row = () => screen.getByTestId('filament-need-PETG');

  function filament(needs = makeNeeds(), { active = true } = {}) {
    const spy = vi.spyOn(api, 'getOrderFilament').mockResolvedValue(needs);
    render(<OrderFilamentPanel orderId={1} active={active} />);
    return spy;
  }

  it('shows need, shelf and «enough» only for a fully known row', async () => {
    filament(makeNeeds({ rows: [need({})] }));
    expect(await screen.findByTestId('filament-need-PETG')).toHaveTextContent('need 2kg');
    expect(row()).toHaveTextContent('on the shelf 4.2kg');
    expect(row()).toHaveTextContent('enough');
  });

  it('writes a known zero need as zero (§13)', async () => {
    filament(makeNeeds({ rows: [need({ need_g: 0 })] }));
    expect(await screen.findByTestId('filament-need-PETG')).toHaveTextContent('need 0g');
  });

  it('never calls «enough» a row with unknown weights (R02)', async () => {
    filament(makeNeeds({ rows: [need({ need_g: 800, short_g: 0, unknown_prints: 2 })] }));
    const r = await screen.findByTestId('filament-need-PETG');
    expect(r).toHaveTextContent('need at least 800g');
    expect(r).toHaveTextContent('enough for the known part');
    expect(within(r).queryByText('enough')).toBeNull();
    expect(r).toHaveTextContent('2 prints without grams');
  });

  it('says «weight unknown» for a row whose whole need is unknown', async () => {
    filament(makeNeeds({ rows: [need({ need_g: 0, short_g: null, unknown_prints: 3 })] }));
    expect(await screen.findByTestId('filament-need-PETG')).toHaveTextContent('need weight unknown');
  });

  it('draws no verdict when the shelf could not be read', async () => {
    filament(makeNeeds({ rows: [need({ have_g: null, short_g: null })], stock_unavailable: true }));
    const r = await screen.findByTestId('filament-need-PETG');
    expect(r).toHaveTextContent('on the shelf —');
    expect(r).not.toHaveTextContent(/enough|short/);
    expect(panel()).toHaveTextContent('The shelf could not be read');
  });

  it('says what is short, at least when weights are missing', async () => {
    filament(makeNeeds({ rows: [need({ short_g: 830, have_g: 1170, unknown_prints: 1 })] }));
    expect(await screen.findByTestId('filament-need-PETG')).toHaveTextContent('short at least 830g');
  });

  it('keeps the prints of unknown filament even with no rows (R02)', async () => {
    filament(makeNeeds({ rows: [], unknown_prints: 2 }));
    expect(await screen.findByText('2 prints with unknown filament')).toBeInTheDocument();
    expect(panel()).not.toHaveTextContent('No calculated need');
  });

  it('says a successful empty answer is no CALCULATED need — not «no plan»', async () => {
    filament(makeNeeds());
    expect(await screen.findByText('No calculated need.')).toBeInTheDocument();
  });

  it('asks nothing for a closed order and says why', () => {
    const spy = filament(makeNeeds(), { active: false });
    expect(panel()).toHaveTextContent('Need is not calculated for a closed order.');
    expect(spy).not.toHaveBeenCalled();
  });

  it('tells a cold failure from an empty answer, and retries it', async () => {
    const spy = vi.spyOn(api, 'getOrderFilament').mockRejectedValue(new Error('boom'));
    render(<OrderFilamentPanel orderId={1} active />);
    const retry = await within(panel()).findByRole('button', { name: 'Retry' });
    expect(panel()).not.toHaveTextContent('No calculated need');
    spy.mockResolvedValue(makeNeeds());
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText('No calculated need.')).toBeInTheDocument());
  });

  it('draws a colour dot only for a colour it can read', async () => {
    filament(makeNeeds({ rows: [need({ colour: '#000000' }), need({ material: 'PLA', colour: 'lagoon' })] }));
    const dark = await screen.findByTestId('filament-need-PETG-#000000');
    expect(dark.querySelector('[data-swatch]')).not.toBeNull();
    expect(screen.getByTestId('filament-need-PLA-lagoon').querySelector('[data-swatch]')).toBeNull();
  });
});
