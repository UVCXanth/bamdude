/**
 * Who may show a part's picture off its own answer (spec procurement-stock-images R7, consilium O5).
 *
 * A picture-only change no longer re-reads a stock or order view's figures — and with them the
 * pictures they carry. Such a view shows its parts through `LivePartThumb`, which reads the picture
 * apart; a plain `PartThumb` there would keep the picture from the view's last read for good. The
 * plain one stays only where the answer itself is refreshed by the change, or is a draft: those
 * files are listed here, each with its reason, and a new use anywhere else fails until it is decided.
 * Read off the TypeScript syntax tree — a JSX tag, an import or any other reference by name.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const SRC = join(process.cwd(), 'src');

/** Files that may use the plain `PartThumb`, and why. */
const PASSIVE: Record<string, string> = {
  'components/PartThumb.tsx': 'the component itself, and LivePartThumb renders it',
  'components/products/PartImageSection.tsx': "the editor's unsaved draft (a new part has id 0) — never the saved picture",
  'components/products/MergePartDialog.tsx': 'the product page: its parts are re-read by every picture change',
  'components/products/detail/CompositionTab.tsx': 'the product page: its parts are re-read by every picture change',
  'components/products/detail/PlatesFilesTab.tsx': 'the product page: its plates are re-read by every picture change',
};

/** The stock and order views that must show their parts live (spec R7). */
const LIVE = [
  'components/projects/ProcurementChecklist.tsx',
  'components/stock/AssembleDialog.tsx',
  'pages/stock/StockItemPage.tsx',
  'components/stock/StockJournal.tsx',
  'components/stock/StockProductsTable.tsx',
  'components/products/ProductStock.tsx',
  'components/projects/LinePartsTable.tsx',
  'components/projects/PartCounts.tsx',
  'components/projects/PlanUnsatisfiable.tsx',
  'components/projects/BankSurplusDialog.tsx',
  'components/projects/LineEditDialog.tsx',
  'components/projects/LineConfigDialog.tsx',
  'components/projects/add-to-order/PartsTab.tsx',
  'components/projects/fulfilment/FulfilmentDialog.tsx',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') walk(path, out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

const rel = (path: string) => relative(SRC, path).split(sep).join('/');

/** Every identifier named `name` in the file, wherever it stands. A file whose text never names it is
 *  not parsed at all: the walk over every source file stays fast enough under a loaded full run. */
function references(path: string, name: string): number {
  const text = readFileSync(path, 'utf8');
  if (!text.includes(name)) return 0;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  let found = 0;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name) found += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('part pictures on stock and order views', () => {
  const files = walk(SRC);

  it('use the plain PartThumb only where the list says why', () => {
    const offenders = files.filter((path) => !(rel(path) in PASSIVE) && references(path, 'PartThumb') > 0).map(rel);
    expect(offenders).toEqual([]);
  });

  it('show every listed view through LivePartThumb', () => {
    const missing = LIVE.filter((file) => references(join(SRC, file), 'LivePartThumb') < 2); // an import and a use
    expect(missing).toEqual([]);
  });

  it('keeps the list honest: every exception still uses the plain one', () => {
    const stale = Object.keys(PASSIVE).filter((file) => references(join(SRC, file), 'PartThumb') === 0);
    expect(stale).toEqual([]);
  });

  it('sees a reference that is not a JSX tag', () => {
    const scratch = ts.createSourceFile('x.tsx', 'const Thumb = PartThumb; export default Thumb;', ts.ScriptTarget.Latest, true);
    let seen = false;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === 'PartThumb') seen = true;
      ts.forEachChild(node, visit);
    };
    visit(scratch);
    expect(seen).toBe(true);
  });
});
