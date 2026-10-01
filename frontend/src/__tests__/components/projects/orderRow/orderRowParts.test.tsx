import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../../utils';
import type { OrderListItem } from '../../../../api/client';
import { ReadyEstimate } from '../../../../components/projects/orderRow/ReadyEstimate';
import { EstimateWarning } from '../../../../components/projects/orderRow/EstimateWarning';
import { OrderCoverage } from '../../../../components/projects/orderRow/OrderCoverage';
import { OrderDue } from '../../../../components/projects/orderRow/OrderDue';
import { OrderThumbs } from '../../../../components/projects/orderRow/OrderThumbs';
import { LiveCounts } from '../../../../components/projects/orderRow/LiveCounts';
import { OrderResponsible } from '../../../../components/projects/orderRow/OrderResponsible';
import { ORDER_ROW_DEFAULTS } from '../../../wireDefaults';

// The host's locale decides the words («Oct 6» / «6 жовт.»); the day and month must be these.
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const row = (over: Partial<OrderListItem> = {}): OrderListItem => ({
  ...ORDER_ROW_DEFAULTS,
  id: 7, code: 'OR-0007', name: 'Lamps', customer_id: null, customer_name: null, color: null, status: 'active',
  stage: 'printing', responsible_id: null, responsible_name: null, due_date: null, priority: 'normal', price: null,
  tags: null, cover_image_filename: null, created_at: '2026-09-01T00:00:00', lines_count: 2, ordered: 10, printed: 4,
  progress: 0.4, covered_units: 4, remaining: 6, from_stock_units: 0, issued_units: 0, line_products: [],
  prints_in_progress: 0, prints_queued: 0, ...over,
});

describe('ReadyEstimate', () => {
  it('shows the admitted date, red when late, the full time in its title', () => {
    render(<ReadyEstimate readiness={{ kind: 'eta', eta: '2026-10-06T09:00:00Z', late: true, after: null, reasons: [] }} />);
    const date = screen.getByTestId('ready-estimate');
    expect(date).toHaveTextContent(day(2026, 10, 6));
    expect(date.querySelector('[data-late="true"]')).not.toBeNull();
    expect(date.querySelector('[title]')?.getAttribute('title')).toMatch(/6/);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('keeps the date and warns beside it when the estimate has reasons (R01)', () => {
    render(
      <ReadyEstimate
        readiness={{ kind: 'eta', eta: '2026-10-06T09:00:00Z', late: false, after: null, reasons: [{ code: 'no_plate', count: 6 }] }}
      />,
    );
    expect(screen.getByTestId('ready-estimate')).toHaveTextContent(day(2026, 10, 6));
    expect(screen.getByRole('img', { name: 'Incomplete estimate: Parts on no plate: 6' })).toBeInTheDocument();
  });

  it('says «after N more urgent» under the date', () => {
    render(
      <ReadyEstimate
        readiness={{ kind: 'eta', eta: '2026-10-06T09:00:00Z', late: false, after: { eta: '2026-10-08T09:00:00Z', ahead: 2 }, reasons: [] }}
      />,
    );
    expect(screen.getByTestId('ready-estimate')).toHaveTextContent(`after 2 more urgent orders: ${day(2026, 10, 8)}`);
  });

  it('names an incomplete estimate without a date, with its reasons', () => {
    render(<ReadyEstimate readiness={{ kind: 'partial', reasons: [{ code: 'unknown_time', count: 2 }] }} />);
    expect(screen.getByTestId('ready-estimate')).toHaveTextContent('incomplete estimate');
    expect(screen.getByRole('img', { name: 'Incomplete estimate: Prints without a time estimate: 2' })).toBeInTheDocument();
  });

  it('tells «no estimate», «all covered», loading, a failed read and a closed order apart', () => {
    const { rerender } = render(<ReadyEstimate readiness={{ kind: 'none' }} />);
    expect(screen.getByTestId('ready-estimate')).toHaveTextContent('no estimate');
    rerender(<ReadyEstimate readiness={{ kind: 'covered' }} />);
    expect(screen.getByTestId('ready-estimate')).toHaveTextContent('all covered');
    rerender(<ReadyEstimate readiness={{ kind: 'loading' }} />);
    expect(screen.getByTestId('ready-estimate')).toHaveAttribute('aria-busy', 'true');
    rerender(<ReadyEstimate readiness={{ kind: 'error' }} />);
    expect(screen.getByTestId('ready-estimate')).toHaveTextContent('—');
    expect(screen.getByTitle('Forecast not read')).toBeInTheDocument();
    rerender(<ReadyEstimate readiness={{ kind: 'closed' }} />);
    expect(screen.getByTestId('ready-estimate')).toHaveTextContent('—');
  });
});

describe('EstimateWarning', () => {
  it('draws nothing for a whole estimate', () => {
    const { container } = render(<EstimateWarning reasons={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('names every reason, with its count where it has one', () => {
    render(<EstimateWarning reasons={[{ code: 'needs_slicing', count: 2 }, { code: 'truncated', count: null }]} />);
    const icon = screen.getByRole('img');
    expect(icon).toHaveAccessibleName(/^Incomplete estimate: Parts only on unsliced plates: 2, .+$/);
    expect(icon.closest('[title]')?.getAttribute('title')).toBe(icon.getAttribute('aria-label'));
  });
});

describe('OrderCoverage', () => {
  it('shows covered / ordered, the percentage and only the sources that are not zero', () => {
    render(<OrderCoverage order={row({ printed: 4, from_stock_units: 3, covered_units: 7, progress: 0.7 })} variant="card" />);
    const cov = screen.getByTestId('order-7-coverage');
    expect(cov).toHaveTextContent('Covered 7 / 10');
    expect(cov).toHaveTextContent('70%');
    expect(cov).toHaveTextContent('printed 4 · from stock 3');
  });
  it('drops a zero source and the label in the table', () => {
    render(<OrderCoverage order={row({ printed: 4, from_stock_units: 0 })} variant="table" />);
    const cov = screen.getByTestId('order-7-coverage');
    expect(cov).toHaveTextContent('4 / 10');
    expect(cov).not.toHaveTextContent('Covered');
    expect(cov).toHaveTextContent('printed 4');
    expect(cov).not.toHaveTextContent('from stock');
  });
  it('draws no sources in a workspace row and a dash for an order with nothing ordered', () => {
    const { rerender } = render(<OrderCoverage order={row({ printed: 4 })} variant="row" />);
    expect(screen.getByTestId('order-7-coverage')).not.toHaveTextContent('printed');
    rerender(<OrderCoverage order={row({ ordered: 0, printed: 0, covered_units: 0, remaining: 0, progress: 0 })} variant="table" />);
    expect(screen.getByTestId('order-7-coverage')).toHaveTextContent('—');
  });
});

describe('OrderDue', () => {
  it('shows the deadline as a calendar day', () => {
    render(<OrderDue order={row({ due_date: '2099-10-07T00:00:00' })} variant="cell" />);
    expect(screen.getByTestId('order-7-due')).toHaveTextContent(day(2099, 10, 7));
    expect(screen.getByTestId('order-7-due')).not.toHaveTextContent('overdue');
  });
  it('marks an active order past its deadline overdue', () => {
    render(<OrderDue order={row({ due_date: '2020-01-02T00:00:00' })} variant="cell" />);
    const due = screen.getByTestId('order-7-due');
    expect(due).toHaveTextContent('overdue');
    expect(due.querySelector('.text-red-600')).not.toBeNull();
  });
  it('shows a dash without a deadline', () => {
    render(<OrderDue order={row()} variant="cell" />);
    expect(screen.getByTestId('order-7-due')).toHaveTextContent('—');
  });
});

describe('OrderThumbs', () => {
  const products = (n: number) => Array.from({ length: n }, (_, i) => ({ product_id: 100 + i, has_cover: i !== 1 }));

  it('draws the order cover first, products after it, three tiles at most and «+N» for the rest', () => {
    render(<OrderThumbs order={row({ cover_image_filename: 'c.png', products: products(5) })} />);
    const strip = screen.getByTestId('order-7-thumbs');
    const imgs = strip.querySelectorAll('img');
    expect(imgs[0].getAttribute('src')).toContain('/projects/7/cover');
    expect(strip.querySelectorAll('[data-thumb]')).toHaveLength(3);
    expect(screen.getByLabelText('3 more products')).toHaveTextContent('+3');
  });
  it('keeps a tile for a product without a cover', () => {
    render(<OrderThumbs order={row({ products: products(2) })} />);
    expect(screen.getByTestId('order-7-thumbs').querySelectorAll('[data-thumb]')).toHaveLength(2);
    expect(screen.getAllByTestId('product-cover-placeholder')).toHaveLength(1);
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });
  it('draws nothing with neither a cover nor products', () => {
    render(<OrderThumbs order={row()} />);
    expect(screen.queryByTestId('order-7-thumbs')).not.toBeInTheDocument();
  });
});

describe('LiveCounts', () => {
  it('names both counts for a screen reader', () => {
    render(<LiveCounts order={row({ prints_in_progress: 2, prints_queued: 3 })} />);
    expect(screen.getByLabelText('printing 2, queued 3')).toHaveTextContent('2');
  });
  it('is a dash when nothing prints or waits', () => {
    render(<LiveCounts order={row()} />);
    expect(screen.getByTestId('order-7-live')).toHaveTextContent('—');
  });
});

describe('OrderResponsible', () => {
  it('shows initials and the name', () => {
    render(<OrderResponsible order={row({ responsible_name: 'Olena Kovalenko' })} />);
    expect(screen.getByText('Olena Kovalenko')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
  });
  it('says unassigned', () => {
    render(<OrderResponsible order={row()} />);
    expect(screen.getByText('unassigned')).toBeInTheDocument();
  });
});
