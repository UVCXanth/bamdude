/**
 * One order as the detail page receives it, and the reads the page makes, for
 * the WS-13 E3 order-detail tests. Every read is a spy on `api`, so a request
 * the page makes that a test did not expect never leaves for the network (the
 * MSW server bypasses unhandled requests).
 */

import { vi } from 'vitest';
import { api } from '../../api/client';
import type { Order, OrderForecastDetail, OrderNeeds, ProjectFigures, ProjectLine } from '../../api/client';

export function makeFigures(over: Partial<ProjectFigures> = {}): ProjectFigures {
  return {
    ordered: 10,
    printed: 6,
    covered_units: 7,
    complete: 0,
    remaining: 3,
    total_time_seconds: 7200,
    total_filament_grams: 420,
    total_filament_cost: 6,
    total_energy_cost: 2,
    total_cost: 8,
    defective: 0,
    margin: 112,
    progress: 0.7,
    other_prints_count: 0,
    all_printed: false,
    from_stock_units: 1,
    bankable_surplus: 0,
    prints_in_progress: 1,
    prints_queued: 2,
    issued_units: 0,
    held_units: 0,
    procurement_cost: 0,
    procurement_known_cost: 0,
    procurement_partial: false,
    cost_with_procurement: 8,
    margin_with_procurement: 112,
    ...over,
  };
}

export function makeLine(over: Partial<ProjectLine> = {}): ProjectLine {
  return {
    id: 10,
    product_id: 1,
    product_name: 'Flask',
    quantity: 10,
    material: 'PETG',
    color: null,
    note: null,
    sort_order: 0,
    units_printed: 6,
    from_stock_units: 1,
    from_finished: 1,
    from_kit_units: 0,
    assembled: 0,
    received: 0,
    issued: 0,
    held: 0,
    written_off: 0,
    covered_units: 7,
    progress: 0.7,
    parts: [],
    archive_ids: [],
    prints_in_progress: 1,
    prints_queued: 2,
    mode: 'product',
    config_key: '',
    configuration: { choices: [], changed_parts: [] },
    ...over,
  } as ProjectLine;
}

export function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 1,
    code: 'OR-0001',
    name: 'Ten flasks',
    customer_id: 2,
    customer_name: 'ACME',
    contact_id: null,
    contact: null,
    description: null,
    color: '#00ae42',
    status: 'active',
    stage: 'printing',
    responsible_id: null,
    responsible_name: null,
    notes: null,
    attachments: null,
    tags: null,
    due_date: null,
    priority: 'normal',
    price: 120,
    url: null,
    cover_image_filename: null,
    created_at: '2026-09-18T09:00:00Z',
    updated_at: '2026-09-18T09:00:00Z',
    lines: [makeLine()],
    procurement: [],
    figures: makeFigures(),
    counts: { prints: 3, issues: 0 },
    other_archive_ids: [],
    ...over,
  };
}

export function makeForecast(over: Partial<OrderForecastDetail> = {}): OrderForecastDetail {
  return {
    project_id: 1,
    now_eta: '2026-09-26T09:37:00Z',
    now_seconds: 50_000,
    after_eta: '2026-09-26T11:12:00Z',
    after_seconds: 55_000,
    machine_seconds: 108_840,
    unknown_prints: 0,
    unroutable_prints: 0,
    eta_complete: true,
    ahead_count: 1,
    assumptions: [],
    incomplete_reasons: [],
    late: false,
    lines: [],
    by_model: [{ model: 'P1S', prints: 12, seconds: 7200, accepting_printers: 6 }],
    ...over,
  };
}

export function makeNeeds(over: Partial<OrderNeeds> = {}): OrderNeeds {
  return { project_id: 1, rows: [], unknown_prints: 0, stock_unavailable: false, assumptions: [], ...over };
}

/** Spy every read the detail page makes; returns the spies a test may want to inspect. */
export function mockOrderDetailApi(order: Order, { forecast = makeForecast(), needs = makeNeeds() } = {}) {
  return {
    getOrder: vi.spyOn(api, 'getOrder').mockResolvedValue(order),
    getOrderPlan: vi.spyOn(api, 'getOrderPlan').mockResolvedValue({
      lines: [],
      totals: { rows: 0, prints: 0, print_time_seconds: 0, filament_used_grams: 0, cost: null },
    } as never),
    getFulfilment: vi.spyOn(api, 'getFulfilment').mockResolvedValue({
      lines: [],
      ordered: order.figures.ordered,
      issued: 0,
      held: 0,
      fully_issued: false,
      closes_to_stock: order.customer_id == null,
      can_complete: false,
      can_assemble: 0,
      can_receive: 0,
      can_issue: 0,
      recipient: { name: null, phone: null, delivery_method: null, delivery_details: null },
    } as never),
    getStockOffers: vi.spyOn(api, 'getStockOffers').mockResolvedValue([]),
    getDeliveryMethods: vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]),
    getDispatchNotes: vi.spyOn(api, 'getDispatchNotes').mockResolvedValue({
      items: [],
      meta: { total: 0, current_page: 1, per_page: 20, last_page: 1 },
    } as never),
    getOrderForecast: vi.spyOn(api, 'getOrderForecast').mockResolvedValue(forecast),
    getOrderFilament: vi.spyOn(api, 'getOrderFilament').mockResolvedValue(needs),
    getOrderQueue: vi.spyOn(api, 'getOrderQueue').mockResolvedValue({ printing: [], pending: [], awaiting: [] }),
    getProjectTimeline: vi.spyOn(api, 'getProjectTimeline').mockResolvedValue([]),
    getProjectArchives: vi.spyOn(api, 'getProjectArchives').mockResolvedValue([]),
  };
}
