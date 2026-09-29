/**
 * What the order page may say about its forecast (WS-13 E3 E04 / G02, R03):
 * one decision for the «Ready ≈» tile and the forecast panel, so the two can
 * never tell different stories — above all, an edited plan and the moment after
 * it was sent never show the previous plan's numbers as current.
 */

import { describe, it, expect } from 'vitest';
import { forecastView } from '../../../components/projects/orderForecastView';
import { makeForecast } from '../../fixtures/orderDetail';

const data = makeForecast();

describe('forecastView', () => {
  it('has nothing to say about a closed order', () => {
    expect(forecastView({ active: false, draft: false, refreshing: false, data, isError: false })).toEqual({ kind: 'closed' });
  });

  it('puts an edited plan before any number, cached or not', () => {
    expect(forecastView({ active: true, draft: true, refreshing: false, data, isError: false })).toEqual({ kind: 'draft' });
  });

  it('shows no previous numbers between a successful send and the fresh forecast (R03)', () => {
    expect(forecastView({ active: true, draft: false, refreshing: true, data, isError: false })).toEqual({ kind: 'loading' });
  });

  it('keeps the answer it has when a background refresh fails, and says so', () => {
    expect(forecastView({ active: true, draft: false, refreshing: false, data, isError: true })).toEqual({
      kind: 'data',
      forecast: data,
      refreshFailed: true,
    });
  });

  it('tells a cold failure from a cold read', () => {
    expect(forecastView({ active: true, draft: false, refreshing: false, data: undefined, isError: true })).toEqual({ kind: 'error' });
    expect(forecastView({ active: true, draft: false, refreshing: false, data: undefined, isError: false })).toEqual({ kind: 'loading' });
  });
});
