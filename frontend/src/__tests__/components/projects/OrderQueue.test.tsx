/**
 * The order's queue section reads its OWN endpoint — both queue tiers, the same
 * rows the order's tiles count (spec workshop-order-queue). It used to filter the
 * farm-wide queue lists on the client, which missed the auto-queue and pulled
 * the whole farm's queue onto one order's page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { OrderQueue } from '../../../components/projects/OrderQueue';
import { strayZeroTextNodes } from '../../domHelpers';

const order = { id: 1, name: 'Ten flasks', status: 'active', lines: [{ id: 10, product_name: 'Flask' }] };
const row = { project_id: 1, project_line_id: 10, archive_id: null, archive_thumbnail: null, archive_name: null, library_file_id: null, library_file_thumbnail: null, library_file_name: null, source_thumbnail: false };
const tiers = {
  printing: [{ archive_id: 5, printer_id: 3, printer_name: 'X1C', name: 'Lid', project_line_id: 10 }],
  pending: [{ ...row, id: 7, archive_name: 'Body', printer_id: 4, printer_name: 'P1S' }],
  awaiting: [
    { ...row, id: 9, library_file_name: 'Base', target_model: 'P1S', target_location: { id: 2, name: 'Shelf A' }, target_location_id: 2, waiting_reason: 'No idle P1S', position: 1 },
    { ...row, id: 11, library_file_name: 'Foot', target_model: null, target_location: null, target_location_id: null, waiting_reason: null, position: 2 },
  ],
};
const EMPTY = { printing: [], pending: [], awaiting: [] };

function mountWithClient(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <OrderQueue orderId={1} />
    </QueryClientProvider>,
  );
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

describe('OrderQueue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getOrder').mockResolvedValue(order as never);
    vi.spyOn(api, 'getSettings').mockResolvedValue({ time_format: 'system' } as never);
    vi.spyOn(api, 'getPrinterStatus').mockResolvedValue({} as never);
  });

  it('reads the order\'s own queue, never the farm-wide lists', async () => {
    const get = vi.spyOn(api, 'getOrderQueue').mockResolvedValue(tiers as never);
    const farm = vi.spyOn(api, 'getQueue').mockResolvedValue([] as never);
    const client = newClient();
    mountWithClient(client);
    await screen.findByText('Body');
    expect(get).toHaveBeenCalledWith(1);
    expect(farm).not.toHaveBeenCalled();
    expect(client.getQueryCache().find({ queryKey: ['project-queue', 1] })).toBeDefined();
  });

  it('draws what is printing, what waits on a printer and what waits for distribution', async () => {
    vi.spyOn(api, 'getOrderQueue').mockResolvedValue(tiers as never);
    mountWithClient(newClient());
    expect(await screen.findByText('Lid')).toBeInTheDocument();
    const onPrinter = screen.getByRole('list', { name: 'In a printer queue' });
    expect(within(onPrinter).getByText('Body')).toBeInTheDocument();
    expect(within(onPrinter).getByText('P1S')).toBeInTheDocument();
    const awaiting = screen.getByRole('list', { name: 'Waiting for distribution' });
    expect(within(awaiting).getByText('Base')).toBeInTheDocument();
    expect(within(awaiting).getByText('For: P1S · Shelf A')).toBeInTheDocument();
    expect(within(awaiting).getByText('No idle P1S')).toBeInTheDocument();
    expect(within(awaiting).getByText('For: any printer')).toBeInTheDocument();
    expect(within(awaiting).getAllByText('Line: Flask')).toHaveLength(2);
    expect(strayZeroTextNodes()).toHaveLength(0);
  });

  it('a closed order with nothing queued draws nothing; a leftover row keeps the section', async () => {
    vi.spyOn(api, 'getOrder').mockResolvedValue({ ...order, status: 'completed' } as never);
    const get = vi.spyOn(api, 'getOrderQueue').mockResolvedValue(EMPTY as never);
    const { unmount } = mountWithClient(newClient());
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText('Queue')).not.toBeInTheDocument();
    unmount();
    get.mockResolvedValue({ ...EMPTY, awaiting: [tiers.awaiting[1]] } as never);
    mountWithClient(newClient());
    expect(await screen.findByText('Foot')).toBeInTheDocument();
  });

  it('names a printing card after the order\'s print, not whatever the printer reports', async () => {
    // Between dispatch and the real start (upload, preheat) the printer still
    // reports the PREVIOUS job — possibly another order's.
    vi.spyOn(api, 'getPrinterStatus').mockResolvedValue({ state: 'FINISH', subtask_name: 'Someone else', cover_url: '/c.png' } as never);
    vi.spyOn(api, 'getOrderQueue').mockResolvedValue(tiers as never);
    mountWithClient(newClient());
    expect(await screen.findByText('Lid')).toBeInTheDocument();
    await waitFor(() => expect(api.getPrinterStatus).toHaveBeenCalled());
    expect(screen.queryByText('Someone else')).not.toBeInTheDocument();
    expect(document.querySelector('img[src*="c.png"]')).toBeNull(); // not live: no cover from the printer either
  });

  it('when its rows change, the order\'s tiles are re-read with them — never on the first answer', async () => {
    // The tiles (`['project', id]`) do not poll and no queue socket event reaches
    // them; the section does both. Moving them together keeps «exactly the jobs
    // the tiles count» true between two order mutations.
    vi.spyOn(api, 'getOrderQueue').mockResolvedValue(tiers as never);
    const client = newClient();
    mountWithClient(client);
    await screen.findByText('Body');
    await waitFor(() => expect(client.getQueryData(['project', 1])).toBeDefined());
    expect(client.getQueryState(['project', 1])?.isInvalidated).toBe(false);
    act(() => client.setQueryData(['project-queue', 1], { ...tiers, pending: [] }));
    await waitFor(() => expect(client.getQueryState(['project', 1])?.isInvalidated).toBe(true));
  });

  it('asks for the order through the same options the page does, meta included', async () => {
    // ⚠️ A query has ONE `meta`, set by whichever observer mounted last. This
    // panel watches `['project', id]` too; when it declared its own options
    // without `meta` it wiped the page's `refreshToast` flag — hence
    // `useOrderDetail`, which both read through.
    vi.spyOn(api, 'getOrderQueue').mockResolvedValue(EMPTY as never);
    const client = newClient();
    mountWithClient(client);
    await waitFor(() =>
      expect(client.getQueryCache().find({ queryKey: ['project', 1] })?.meta).toEqual({ refreshToast: true }),
    );
  });
});
