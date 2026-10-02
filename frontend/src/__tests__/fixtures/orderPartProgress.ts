import type { OrderPartProgress, PartContribution, PlateRecipe, ProjectLine } from '../../api/client';

/** Synthetic current-API payloads only. No server data or inferred attribution. */
const baseLine: ProjectLine = {
  id: 101,
  product_id: 201,
  product_name: 'Product A',
  quantity: 4,
  material: 'PLA',
  color: null,
  note: null,
  sort_order: 0,
  units_printed: 0,
  from_stock_units: 1,
  from_finished: 0,
  from_kit_units: 1,
  assembled: 0,
  received: 0,
  issued: 0,
  held: 0,
  written_off: 0,
  covered_units: 1,
  progress: 0.25,
  parts: [],
  archive_ids: [501, 502],
  prints_in_progress: 1,
  prints_queued: 0,
  mode: 'product',
  config_key: '',
  configuration: { choices: [], changed_parts: [] },
};

export const productALine: ProjectLine = {
  ...baseLine,
  parts: [
    // Four Product A kits require 12 A parts and 4 B parts. The API's `need`
    // already excludes the reserved kit: 9 and 3. Values below are fixture
    // constants, not a frontend implementation of accounting rules.
    { part_id: 301, name: 'Part A', qty_per_unit: 3, need: 9, usable: 4, in_progress: 3, remaining: 5, surplus: 0 },
    { part_id: 302, name: 'Part B', qty_per_unit: 1, need: 3, usable: 0, in_progress: 0, remaining: 3, surplus: 0 },
  ],
};

export const productBLine: ProjectLine = {
  ...baseLine,
  id: 102,
  product_id: 202,
  product_name: 'Product B',
  quantity: 2,
  sort_order: 1,
  from_stock_units: 0,
  from_kit_units: 0,
  covered_units: 0,
  progress: 0,
  // A single plate can be attributed to both lines. This is not an allocation
  // of each archive part row to a BOM part; that breakdown is absent from API.
  archive_ids: [501],
  prints_in_progress: 0,
  parts: [
    { part_id: 303, name: 'Part C', qty_per_unit: 2, need: 4, usable: 1, in_progress: 0, remaining: 3, surplus: 0 },
  ],
};

const recipe: PlateRecipe = {
  id: 401,
  library_file_id: 601,
  plate_index: 1,
  filename: 'fixture.3mf',
  sliced: true,
  yield: [{ part_id: 301, name: 'Part A', count: 3 }],
  unassigned: [],
  materials: ['PLA'],
  colors: [],
  printer_model: null,
  print_time_seconds: 3600,
  filament_used_grams: 30,
};

export const productARecipes: PlateRecipe[] = [
  recipe,
  { ...recipe, id: 402, plate_index: 2, yield: [{ part_id: 302, name: 'Part B', count: 1 }] },
  { ...recipe, id: 403, library_file_id: 602, plate_index: 1, yield: [{ part_id: 301, name: 'Part A', count: 6 }] },
];

const contribution: PartContribution = {
  source_kind: 'archive', source_id: 501, filename: 'part-b.3mf',
  library_file_id: 601, recipe_id: 401, plate_index: 1, runs: 1, expected_qty: 5,
  completed_good_qty: 4, printing_qty: 0, queued_qty: 0, rejected_qty: 1,
};

/** Literal server-contract fixtures. Identity comes from IDs, not filenames. */
export const orderPartProgress: OrderPartProgress = {
  order_id: 1,
  parts: [
    {
      order_line_id: 101, product_id: 201, product_name: 'Product A', part_id: 301, part_name: 'Part A',
      required_qty: 12, free_stock_qty: 6, allocated_stock_qty: 3, completed_good_qty: 4,
      printing_qty: 3, queued_qty: 3, rejected_qty: 1, secured_qty: 7, remaining_qty: 0,
      contributions: [
        contribution,
        { ...contribution, source_id: 502, expected_qty: 3, completed_good_qty: 0, printing_qty: 3, rejected_qty: 0 },
        { ...contribution, source_kind: 'printer_queue', source_id: 701, expected_qty: 3, completed_good_qty: 0, queued_qty: 3, rejected_qty: 0 },
        { ...contribution, source_kind: 'recipe', source_id: 403, recipe_id: 403, library_file_id: 602,
          filename: 'alternative.3mf', runs: 0, expected_qty: 6, completed_good_qty: 0, rejected_qty: 0 },
      ],
    },
    {
      order_line_id: 101, product_id: 201, product_name: 'Product A', part_id: 302, part_name: 'Part B',
      required_qty: 4, free_stock_qty: 5, allocated_stock_qty: 0, completed_good_qty: 0,
      printing_qty: 0, queued_qty: 0, rejected_qty: 0, secured_qty: 0, remaining_qty: 4,
      contributions: [{ ...contribution, source_kind: 'recipe', source_id: 402, recipe_id: 402, plate_index: 2,
        runs: 0, expected_qty: 1, completed_good_qty: 0, rejected_qty: 0 }],
    },
    {
      order_line_id: 102, product_id: 202, product_name: 'Product B', part_id: 303, part_name: 'Part C',
      required_qty: 4, free_stock_qty: 0, allocated_stock_qty: 0, completed_good_qty: 0,
      printing_qty: 0, queued_qty: 0, rejected_qty: 0, secured_qty: 0, remaining_qty: 4, contributions: [],
    },
  ],
  unallocated: [{
    ...contribution, source_id: 503, expected_qty: 8, completed_good_qty: 6, rejected_qty: 2,
    recipe_id: null, part_name: 'Part A', reason: 'ambiguous', candidate_pairs: [[101, 301], [103, 301]],
  }],
};
