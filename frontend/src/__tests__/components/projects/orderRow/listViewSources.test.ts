import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WS-13 E7 B05 / B07 — a source scan over the order list views.
 *
 * Every date in a list goes through the row parts (`orderRow/`), which format it
 * with the user's date setting; a raw `toLocaleDateString(` there is the second
 * formatter the stage removed. The list grows as each view moves onto the parts.
 */
const SRC = join(process.cwd(), 'src');
const ROW_DIR = 'components/projects/orderRow';
const LIST_VIEWS: string[] = [
  'components/projects/OrdersTable.tsx',
  'components/projects/OrderCard.tsx',
  'components/projects/board/BoardCard.tsx',
  'components/projects/OrdersWorkspace.tsx',
  'components/projects/OrdersDeadlines.tsx',
];

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('order list view sources', () => {
  it('format no date by hand', () => {
    const files = [
      ...readdirSync(join(SRC, ROW_DIR)).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts')).map((f) => `${ROW_DIR}/${f}`),
      ...LIST_VIEWS,
    ];
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => read(f).includes('toLocaleDateString('));
    expect(offenders).toEqual([]);
  });

  // B07: a row's menu is the order's one action model (E6) — never a menu of the view's own.
  it('draw each row menu with the order action menu', () => {
    for (const f of ['components/projects/OrdersTable.tsx', 'components/projects/OrderCard.tsx', 'components/projects/board/BoardCard.tsx']) {
      expect(read(f), f).toContain('<OrderActionMenu');
    }
  });
});
