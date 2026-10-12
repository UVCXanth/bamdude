/**
 * Spec part-thumbnails §12.2, plan E6 (task 42): the plan names its parts with their pictures — a row's
 * «covers», a line's «outstanding» and «surplus after», a part no plate can make — and the picture of a
 * projected surplus travels with its name out of the plates' yields (D4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../../utils';
import { strayZeroTextNodes } from '../../domHelpers';
import { api } from '../../../api/client';
import type {
  LinePlan,
  Order,
  OrderForecastDetail,
  OrderNeeds,
  PartImageRef,
  PlateRecipe,
  Printer,
} from '../../../api/client';
import { PlanBlock } from '../../../components/projects/PlanBlock';
import { projectPlan } from '../../../components/projects/planMath';
import { FORECAST_DEFAULTS } from '../../wireDefaults';

const body: PartImageRef = { kind: 'render', status: 'ready', v: 'b1' };
const cap: PartImageRef = { kind: 'render', status: 'ready', v: 'c2' };
const src = (id: number, v: string) => `/api/v1/product-parts/${id}/image?v=${v}&size=sm`;
const pictures = (el: HTMLElement) =>
  within(el)
    .getAllByTestId('part-thumb-img')
    .map((img) => img.getAttribute('src'));

const order = {
  id: 1,
  name: 'Ten flasks',
  status: 'active',
  lines: [
    {
      id: 10,
      product_id: 7,
      product_name: 'Flask',
      quantity: 12,
      material: 'PETG',
      color: null,
      note: null,
      sort_order: 0,
      units_printed: 0,
      covered_units: 0,
      progress: 0,
      archive_ids: [],
      parts: [
        { part_id: 1, name: 'Body', qty_per_unit: 1, need: 12, usable: 0, in_progress: 0, remaining: 12, surplus: 0 },
        { part_id: 2, name: 'Cap', qty_per_unit: 1, need: 12, usable: 9, in_progress: 0, remaining: 3, surplus: 0 },
      ],
    },
  ],
} as unknown as Order;

const line: LinePlan = {
  line_id: 10,
  product_id: 7,
  product_name: 'Flask',
  material: 'PETG',
  outstanding_before: [{ part_id: 1, name: 'Body', count: 12, image: body }],
  rows: [
    {
      plate_id: 100,
      library_file_id: 5,
      plate_index: 1,
      filename: 'big.3mf',
      hidden: false,
      count: 1,
      useful: [{ part_id: 1, name: 'Body', count: 12, image: body }],
      print_time_seconds: 3600,
      filament_used_grams: 100,
      cost: 2,
      time_unknown: false,
      printer_model: null,
      alternatives: [],
    },
  ],
  surplus_after: [],
  unsatisfiable: [{ part_id: 2, name: 'Cap', count: 3, image: cap }],
  candidates: [100],
  not_sliced: [],
};

// One print of the plate makes 16 bodies against 12 outstanding: «Body +4», computed on the client.
const plates: PlateRecipe[] = [
  {
    id: 100,
    library_file_id: 5,
    plate_index: 1,
    filename: 'big.3mf',
    hidden: false,
    sliced: true,
    yield: [{ part_id: 1, name: 'Body', count: 16, image: body }],
    unassigned: [],
    materials: ['PETG'],
    colors: [],
    printer_model: null,
    print_time_seconds: 3600,
    filament_used_grams: 100,
  },
];

const forecast: OrderForecastDetail = {
  ...FORECAST_DEFAULTS,
  by_model: [],
  project_id: 1,
  now_eta: null,
  now_seconds: null,
  after_eta: null,
  after_seconds: null,
  machine_seconds: 0,
  unknown_prints: 0,
  unroutable_prints: 0,
  eta_complete: true,
  ahead_count: 0,
  assumptions: [],
  lines: [],
};
const needs: OrderNeeds = { project_id: 1, rows: [], unknown_prints: 0, stock_unavailable: false, assumptions: ['slicer_estimate'] };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'getOrderPlan').mockResolvedValue({
    lines: [line],
    totals: { rows: 0, prints: 1, print_time_seconds: 3600, filament_used_grams: 100, cost: 2 },
  });
  vi.spyOn(api, 'getProductPlates').mockResolvedValue(plates);
  vi.spyOn(api, 'getUiPreferences').mockResolvedValue({ currency: 'UAH' } as never);
  vi.spyOn(api, 'getPrinters').mockResolvedValue([] as unknown as Printer[]);
  vi.spyOn(api, 'getModelCompatibility').mockResolvedValue({ models: {} });
  vi.spyOn(api, 'getOrderForecast').mockResolvedValue(forecast);
  vi.spyOn(api, 'getOrderFilament').mockResolvedValue(needs);
});

describe('the plan’s parts carry their pictures (spec part-thumbnails §12.2)', () => {
  it('a row names what it covers with each part’s picture', async () => {
    render(<PlanBlock order={order} canEdit />);
    const row = await screen.findByTestId('plan-row-10-100');
    const covers = within(row).getByText('Body × 12').closest('td') as HTMLElement;
    expect(pictures(covers)).toEqual([src(1, 'b1')]);
  });

  it('the line says what is outstanding and what the plan leaves over, each part with its picture', async () => {
    render(<PlanBlock order={order} canEdit />);
    const head = await screen.findByTestId('plan-line-10-head');
    expect(head).toHaveTextContent('Outstanding: Body × 12');
    expect(pictures(head)).toEqual([src(1, 'b1')]);
    const surplus = await screen.findByTestId('plan-line-10-surplus');
    expect(surplus).toHaveTextContent('Body +4');
    expect(pictures(surplus)).toEqual([src(1, 'b1')]);
    expect(strayZeroTextNodes(screen.getByTestId('plan-block'))).toHaveLength(0);
  });

  it('a part no plate can make shows its picture beside the sentence', async () => {
    render(<PlanBlock order={order} canEdit />);
    const banner = await screen.findByTestId('plan-unsatisfiable-10-2');
    expect(banner).toHaveTextContent('No plate for «Cap» × 3 in PETG.');
    expect(within(banner).getByRole('button', { name: 'Show Cap larger' })).toBeInTheDocument();
    expect(pictures(banner)).toEqual([src(2, 'c2')]);
  });
});

describe('projectPlan', () => {
  it('a projected surplus carries the picture of the yield it comes from (plan E6, D4)', () => {
    const projected = projectPlan(
      { ...line, outstanding_before: [{ part_id: 1, name: 'Body', count: 12 }] },
      {},
      { 100: [{ part_id: 1, name: 'Body', count: 16, image: body }] },
    );
    expect(projected.surplusAfter).toEqual([{ part_id: 1, name: 'Body', count: 4, image: body }]);
  });
});
