import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { TimelineEvent } from '../../../api/client';
import { OrderTimeline } from '../../../components/projects/OrderTimeline';
import { ORDER_JOURNAL_KINDS } from '../../../components/projects/orderJournal';
import { JOURNAL_ICONS } from '../../../components/projects/orderJournalIcons';

const ev = (event_type: string, metadata: Record<string, unknown>, title = 'x'): TimelineEvent => ({
  event_type,
  timestamp: '2026-09-26T10:00:00',
  title,
  description: null,
  metadata,
});

describe('OrderTimeline · a failed read (WS-13 E3, review 7)', () => {
  it('says the activity could not be read and offers a retry — not «no activity»', async () => {
    const get = vi.spyOn(api, 'getProjectTimeline').mockRejectedValue(new Error('boom'));
    vi.spyOn(api, 'getSettings').mockResolvedValue({} as never);
    render(<OrderTimeline orderId={1} />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByText(/No activity/i)).toBeNull();
    get.mockResolvedValue([]);
    retry.click();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});

describe('OrderTimeline · a failed refresh (WS-13 E3, the V03 class)', () => {
  it('says the last answer could not be refreshed, with a retry — an empty journal too', async () => {
    const get = vi.spyOn(api, 'getProjectTimeline').mockResolvedValue([]);
    vi.spyOn(api, 'getSettings').mockResolvedValue({} as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <OrderTimeline orderId={1} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('No activity yet.')).toBeInTheDocument();
    get.mockRejectedValue(new Error('boom'));
    await act(() => client.refetchQueries({ queryKey: ['project-timeline', 1] }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText(/Could not refresh/)).toBeInTheDocument();
  });
});

describe('JOURNAL_ICONS (WS-13 E3 G05)', () => {
  it('has an icon for every kind the journal writes — none is an empty dot', () => {
    for (const kind of ORDER_JOURNAL_KINDS) expect(JOURNAL_ICONS[kind], kind).toBeDefined();
  });
});

describe('OrderTimeline · the order journal', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says each journal line as a sentence in the reader’s language, with who did it', async () => {
    vi.spyOn(api, 'getProjectTimeline').mockResolvedValue([
      ev('stage_changed', { from: 'prep', to: 'qc', user_name: 'ira' }),
      ev('fields_changed', { fields: ['name', 'due_date'], user_name: null }),
      ev('order_created', { source: 'copy', from_code: 'OR-0003' }),
      ev('responsible_changed', { from: null, to: { id: 2, name: 'ira' } }),
      ev('mystery', {}, 'Mystery'),
    ]);
    render(<OrderTimeline orderId={5} />);
    expect(await screen.findByText('Stage: Preparation → Quality check')).toBeInTheDocument();
    expect(screen.getByText(/· ira/)).toBeInTheDocument();
    expect(screen.getByText('Order details changed: name, due date')).toBeInTheDocument();
    expect(screen.getByText('Created as a copy of OR-0003')).toBeInTheDocument();
    expect(screen.getByText('Responsible: Not assigned → ira')).toBeInTheDocument();
    expect(screen.getByText('Mystery')).toBeInTheDocument(); // an unknown type keeps the server's title
  });

  it('a line whose product is gone still reads as a sentence', async () => {
    vi.spyOn(api, 'getProjectTimeline').mockResolvedValue([ev('line_removed', { product: null, quantity: 5 })]);
    render(<OrderTimeline orderId={5} />);
    expect(await screen.findByText('Line removed: — × 5')).toBeInTheDocument();
  });
});
