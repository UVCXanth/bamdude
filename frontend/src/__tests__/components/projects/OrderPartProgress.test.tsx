import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../../api/client';
import i18n from '../../../i18n';
import { OrderPartProgress, OrderPartProgressContent } from '../../../components/projects/OrderPartProgress';
import { orderPartProgress } from '../../fixtures/orderPartProgress';

describe('OrderPartProgress', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders full BOM demand, secured and expected part counts from the API', () => {
    render(<OrderPartProgressContent data={orderPartProgress} />);
    const a = screen.getByTestId('progress-101-301');
    expect(a).toHaveTextContent('Secured: 7 / 12 · printing 3 · queued 3 · remaining 0');
    expect(a).toHaveTextContent('Allocated stock 3');
    expect(a).toHaveTextContent('Printed good 4');
    expect(a).toHaveTextContent('Rejected 1');
    expect(a).toHaveTextContent('Free stock 6');
    expect(screen.getByTestId('progress-101-302')).toHaveTextContent('Secured: 0 / 4');
    expect(screen.getByTestId('progress-102-303')).toHaveTextContent('Product B');
  });

  it('keeps free stock, rejects and incoming output out of secured progress', () => {
    render(<OrderPartProgressContent data={orderPartProgress} />);
    const bar = screen.getByRole('progressbar', { name: 'Part A' });
    expect(bar).toHaveAttribute('aria-valuenow', '7');
    expect(bar).toHaveAttribute('aria-valuemax', '12');
    expect(bar.querySelectorAll('[data-segment]')).toHaveLength(4);
    const stock = bar.querySelector('[data-segment="allocated_stock_qty"]');
    expect(stock).toHaveStyle({ width: '25%' });
    // Clip an over-planned stack geometrically without changing API figures.
    expect(bar.querySelector('[data-segment="queued_qty"]')).toHaveStyle({ width: `${2 / 12 * 100}%` });
    expect(screen.getByRole('progressbar', { name: 'Part B' })).toHaveAttribute('aria-valuenow', '0');
  });

  it('shows files only in detail, including runs versus expected parts and unused recipes', () => {
    render(<OrderPartProgressContent data={{ ...orderPartProgress, unallocated: [] }} />);
    expect(screen.queryByText('alternative.3mf')).not.toBeInTheDocument();
    const a = screen.getByTestId('progress-101-301');
    fireEvent.click(within(a).getByRole('button'));
    expect(within(a).getByText('alternative.3mf')).toBeInTheDocument();
    const pending = within(a).getByText('Printer queue #701').closest('li')!;
    expect(pending).toHaveTextContent('Runs: 1');
    expect(pending).toHaveTextContent('Expected parts: 3');
    const idle = within(a).getByText('Linked recipe #403').closest('li')!;
    expect(idle).toHaveTextContent('Runs: 0');
    expect(idle).toHaveTextContent('Expected parts: 6');
    fireEvent.click(within(a).getByRole('button'));
    expect(within(a).queryByText('alternative.3mf')).not.toBeInTheDocument();
  });

  it('displays ambiguous output separately without adding it to any row', () => {
    render(<OrderPartProgressContent data={orderPartProgress} />);
    const warning = screen.getByRole('status');
    expect(warning).toHaveTextContent('Ambiguous allocation');
    expect(warning).toHaveTextContent('#101 / #301, #103 / #301');
    expect(warning).toHaveTextContent('Printed good 6');
    expect(screen.getByTestId('progress-101-301')).toHaveTextContent('Secured: 7 / 12');
  });

  it('uses server remaining on rerender rather than recalculating accounting', () => {
    const { rerender } = render(<OrderPartProgressContent data={orderPartProgress} />);
    rerender(<OrderPartProgressContent data={{ ...orderPartProgress, parts: [{ ...orderPartProgress.parts[0], remaining_qty: 9 }] }} />);
    expect(screen.getByTestId('progress-101-301')).toHaveTextContent('remaining 9');
  });

  it('supports the Ukrainian captions', async () => {
    await i18n.changeLanguage('uk');
    render(<OrderPartProgressContent data={orderPartProgress} />);
    expect(screen.getByTestId('progress-101-301')).toHaveTextContent('Забезпечено: 7 / 12');
    expect(screen.getByTestId('progress-101-301')).toHaveTextContent('Вільний склад 6');
    expect(screen.getByRole('status')).toHaveTextContent('Неоднозначний / нерозподілений вихід');
  });

  it('fetches the projection and collapses the whole section', async () => {
    vi.spyOn(api, 'getOrderPartProgress').mockResolvedValue(orderPartProgress);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><OrderPartProgress orderId={1} /></QueryClientProvider>);
    expect(await screen.findByTestId('progress-101-301')).toBeInTheDocument();
    expect(api.getOrderPartProgress).toHaveBeenCalledWith(1);
    const toggle = screen.getByRole('button', { name: 'Part progress' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('progress-101-301')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByTestId('progress-101-301')).toBeInTheDocument();
  });

  it('shows a retryable API failure without rendering fabricated zero counters', async () => {
    vi.spyOn(api, 'getOrderPartProgress').mockRejectedValue(new Error('unavailable'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><OrderPartProgress orderId={1} /></QueryClientProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load part progress.');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
