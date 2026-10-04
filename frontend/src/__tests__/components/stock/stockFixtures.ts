import type { StockItem, StockItemDetail } from '../../../api/client';

/** Pipe, standard tail, position SK-0005 — five on the shelf, two held. */
export const pipeItem: StockItem = {
  id: 5,
  code: 'SK-0005',
  product: { id: 1, name: 'Pipe', sku: 'PP-1', has_cover: false },
  configuration: {
    choices: [{ group_id: 10, group_name: 'Tail', option_id: 100, option_name: 'straight', is_default: true }],
    changed_parts: [],
  },
  location: 'A-1',
  on_hand: 5,
  reserved: 2,
  available: 3,
  min_qty: 0,
  below_min: false,
  short_by: 0,
  can_assemble: 1,
};

export const pipeDetail: StockItemDetail = {
  ...pipeItem,
  min_qty: 10,
  below_min: true,
  short_by: 7,
  reservations: [{ project_line_id: null, project_id: null, project_code: null, project_name: null, qty: 2 }],
  siblings: [
    {
      id: 7,
      code: 'SK-0007',
      configuration: {
        choices: [{ group_id: 10, group_name: 'Tail', option_id: 101, option_name: 'angled', is_default: false }],
        changed_parts: [],
      },
      on_hand: 2,
      available: 0,
    },
  ],
  parts: [
    { part_id: 11, name: 'flask', per: 1, on_shelf: 4 },
    { part_id: 12, name: 'tail', per: 2, on_shelf: 3 },
  ],
};

/** The catalog product behind the fixtures, with one variant group. */
export const pipeProduct = {
  id: 1,
  code: 'PR-0001',
  name: 'Pipe',
  is_active: true,
  sku: 'PP-1',
  version: null,
  category: null,
  status: 'ready',
  origin: 'catalog',
  origin_file_id: null,
  origin_plate_index: null,
  cover_image_filename: null,
  has_cover: false,
  parts_count: 2,
  plates_count: 1,
  lines_count: 0,
  kits_available: 1,
  parts: [],
  variant_groups: [
    {
      id: 10,
      name: 'Tail',
      position: 0,
      default_option_id: 100,
      options: [
        { id: 100, name: 'straight', position: 0 },
        { id: 101, name: 'angled', position: 1 },
      ],
    },
  ],
};
