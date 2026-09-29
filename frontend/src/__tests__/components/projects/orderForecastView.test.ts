/**
 * What the order page may say about its forecast (WS-13 E3 E04 / G02, R03):
 * one decision for the «Ready ≈» tile and the forecast panel, so the two can
 * never tell different stories — above all, an edited plan and the moment after
 * it was sent never show the previous plan's numbers as current, and a failed
 * re-read after a send ends in a retry, not in «loading» for ever.
 */

import { describe, it, expect } from 'vitest';
import { forecastView } from '../../../components/projects/orderForecastView';
import { makeForecast } from '../../fixtures/orderDetail';

const data = makeForecast();
const base = { active: true, draft: false, sentAt: null, dataUpdatedAt: 100, errorUpdatedAt: 0, data, isError: false };

describe('forecastView', () => {
  it('has nothing to say about a closed order', () => {
    expect(forecastView({ ...base, active: false })).toEqual({ kind: 'closed' });
  });

  it('puts an edited plan before any number, cached or not', () => {
    expect(forecastView({ ...base, draft: true })).toEqual({ kind: 'draft' });
  });

  it('shows no previous numbers between a successful send and the fresh forecast (R03)', () => {
    expect(forecastView({ ...base, sentAt: 200, dataUpdatedAt: 100 })).toEqual({ kind: 'loading' });
  });

  it('ends a failed re-read after a send in an error with a retry, never in «loading» for ever', () => {
    expect(forecastView({ ...base, sentAt: 200, dataUpdatedAt: 100, errorUpdatedAt: 250, isError: true })).toEqual({ kind: 'error' });
  });

  it('shows the forecast read after the send', () => {
    expect(forecastView({ ...base, sentAt: 200, dataUpdatedAt: 300 })).toEqual({ kind: 'data', forecast: data, refreshFailed: false });
  });

  it('keeps the answer it has when a background refresh fails, and says so', () => {
    expect(forecastView({ ...base, isError: true, errorUpdatedAt: 150 })).toEqual({ kind: 'data', forecast: data, refreshFailed: true });
  });

  it('tells a cold failure from a cold read', () => {
    expect(forecastView({ ...base, data: undefined, dataUpdatedAt: 0, isError: true, errorUpdatedAt: 10 })).toEqual({ kind: 'error' });
    expect(forecastView({ ...base, data: undefined, dataUpdatedAt: 0 })).toEqual({ kind: 'loading' });
  });
});
