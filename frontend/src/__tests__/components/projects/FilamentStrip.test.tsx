import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { FarmNeeds } from '../../../api/client';
import { FilamentStrip } from '../../../components/projects/FilamentStrip';
import { __resetColorCatalogForTests, setColorCatalog } from '../../../utils/colors';

type Row = FarmNeeds['rows'][number];
const r = (over: Partial<Row> = {}): Row => ({
  material: 'PLA', colour: 'black', need_g: 300, have_g: 1000, have_type_g: 2500, short_g: 0, unknown_prints: 0,
  orders_count: 2, ...over,
});
const farm = (over: Partial<FarmNeeds> = {}): FarmNeeds => ({
  rows: [r()], orders_count: 2, unknown_prints: 0, stock_unavailable: false, assumptions: ['slicer_estimate'], ...over,
});
const strip = () => screen.findByTestId('filament-strip');
// The panel stands while the need is read; the chips are the answer.
const loaded = async () => {
  await screen.findAllByTestId(/^filament-chip-/);
  return screen.getByTestId('filament-strip');
};

describe('FilamentStrip', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('is a panel titled as an estimate, with «need / have» chips', async () => {
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue(farm({ rows: [r(), r({ material: 'PETG', colour: 'white', need_g: 1200, have_g: 200, short_g: 1000 })] }));
    render(<FilamentStrip />);
    const panel = await loaded();
    expect(within(panel).getByRole('heading', { name: /Filament \(slicer estimate, not actual use\)/ })).toBeInTheDocument();
    const chips = within(panel).getAllByTestId(/^filament-chip-/);
    expect(chips[0]).toHaveTextContent('PLA black · need 300g / have 1kg');
    expect(chips[1]).toHaveTextContent('PETG white · need 1.2kg / have 200g · short 1kg');
    expect(chips[1]).toHaveAttribute('data-short', 'true');
  });

  // R02: green only when every weight and every shelf is known and nothing is short.
  it.each([
    ['weight wholly unknown', farm({ rows: [r({ need_g: 0, unknown_prints: 2 })] })],
    ['weight partly known', farm({ rows: [r({ unknown_prints: 1 })] })],
    ['prints without a row', farm({ unknown_prints: 3 })],
    ['the shelf unreadable', farm({ stock_unavailable: true, rows: [r({ have_g: null, short_g: null })] })],
  ])('never says «everything is on the shelf» when %s', async (_name, data) => {
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue(data);
    render(<FilamentStrip />);
    await loaded();
    expect(screen.queryByText('everything is on the shelf')).not.toBeInTheDocument();
  });

  it('says «everything is on the shelf» when everything is known and enough', async () => {
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue(farm());
    render(<FilamentStrip />);
    expect(await screen.findByText('everything is on the shelf')).toBeInTheDocument();
  });

  it('shows an unknown as a dash or a lower bound, never a zero', async () => {
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue(
      farm({ stock_unavailable: true, unknown_prints: 3, rows: [r({ need_g: 0, unknown_prints: 2, have_g: null, short_g: null }), r({ material: 'ABS', unknown_prints: 1 })] }),
    );
    render(<FilamentStrip />);
    const chips = within(await loaded()).getAllByTestId(/^filament-chip-/);
    expect(chips[0]).toHaveTextContent('need — / have —');
    expect(chips[1]).toHaveTextContent('need ≥ 300g');
    expect(screen.getByText('The shelf could not be read — showing the need only')).toBeInTheDocument();
    expect(screen.getByText('3 more prints without an estimate')).toBeInTheDocument();
  });

  it('shows seven chips and unfolds the rest in place', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => r({ material: `M${i}`, colour: null }));
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue(farm({ rows }));
    render(<FilamentStrip />);
    const panel = await loaded();
    expect(within(panel).getAllByTestId(/^filament-chip-/)).toHaveLength(7);
    const more = within(panel).getByRole('button', { name: '3 more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(within(panel).getAllByTestId(/^filament-chip-/)).toHaveLength(10);
    expect(within(panel).getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('draws a swatch only for a colour it can name as a hex — never an invented one', async () => {
    setColorCatalog({ '00ae42': 'Bambu Green' });
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue(
      farm({ rows: [r({ colour: '#ff0000' }), r({ material: 'PETG', colour: 'bambu green' }), r({ material: 'ABS', colour: 'чорний' })] }),
    );
    render(<FilamentStrip />);
    const chips = within(await loaded()).getAllByTestId(/^filament-chip-/);
    expect(chips[0].querySelector('[data-swatch]')).toHaveStyle({ backgroundColor: '#ff0000' });
    expect(chips[1].querySelector('[data-swatch]')).toHaveStyle({ backgroundColor: '#00ae42' });
    expect(chips[2].querySelector('[data-swatch]')).toBeNull();
    __resetColorCatalogForTests();
  });

  it('is absent when no active order needs filament', async () => {
    const get = vi.spyOn(api, 'getOrdersFilament').mockResolvedValue(farm({ rows: [], orders_count: 0 }));
    render(<FilamentStrip />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((res) => setTimeout(res, 20));
    expect(screen.queryByTestId('filament-strip')).not.toBeInTheDocument();
  });

  // V03 (Codex r1): a cached answer whose re-read failed is not current — the panel says so with a
  // retry (an empty answer too, which otherwise hides the panel), keeps the last figures and drops
  // the green «everything is on the shelf».
  it.each([
    ['enough on the shelf', farm()],
    ['nothing needed', farm({ rows: [], orders_count: 0 })],
  ])('says a failed re-read with a retry over a cached answer of %s, never the green line', async (_name, cached) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(['orders-filament'], cached);
    const get = vi.spyOn(api, 'getOrdersFilament').mockRejectedValue(new Error('down'));
    render(
      <QueryClientProvider client={qc}>
        <FilamentStrip />
      </QueryClientProvider>,
    );
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['orders-filament'] });
    });
    const panel = await strip();
    expect(within(panel).getByText('Could not refresh')).toBeInTheDocument();
    expect(within(panel).queryByText('everything is on the shelf')).not.toBeInTheDocument();
    get.mockResolvedValue(farm());
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('everything is on the shelf')).toBeInTheDocument();
    expect(screen.queryByText('Could not refresh')).not.toBeInTheDocument();
    qc.clear();
  });

  it('keeps its place while loading and offers a retry when the need could not be read', async () => {
    const get = vi.spyOn(api, 'getOrdersFilament').mockRejectedValue(new Error('down'));
    render(<FilamentStrip />);
    expect(await strip()).toHaveAttribute('aria-busy', 'true');
    const retry = await screen.findByRole('button', { name: 'Retry' }, { timeout: 4000 });
    expect(screen.getByText('The filament estimate could not be read')).toBeInTheDocument();
    get.mockResolvedValue(farm());
    await userEvent.click(retry);
    expect(await screen.findByText('everything is on the shelf')).toBeInTheDocument();
  });
});
