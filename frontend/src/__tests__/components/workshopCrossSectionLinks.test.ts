/**
 * A link into another Workshop section goes through `SectionLink` (WS-13 E13 O19): each section's
 * route sends a reader without its read back to «/» without a word, so a raw link there is a door
 * that only bounces — the storekeeper's «Open product», an orders reader's customer. A link inside
 * its own section needs no check: its reader is already there.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');
type Section = 'projects' | 'products' | 'customers' | 'stock';
// Which section a Workshop file belongs to, by its folder.
const OWN: [string, Section][] = [
  ['components/projects', 'projects'],
  ['pages/orders', 'projects'],
  ['components/products', 'products'],
  ['pages/products', 'products'],
  ['components/customers', 'customers'],
  ['pages/customers', 'customers'],
  ['components/stock', 'stock'],
  ['pages/stock', 'stock'],
];
// Outside the Workshop a link was checked by hand before this test existed; it stays named here.
const CHECKED_BY_HAND: Record<string, string> = {
  'pages/ArchivesPage.tsx': 'the order chip is a link only with orders:read (WS-13 E13 ARC-01)',
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : files(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

const RAW_LINK = /<Link\s[^>]*?\bto=\{?\s*[`'"]\/(projects|products|customers|stock)\b/g;

describe('links between Workshop sections', () => {
  it('no raw link leads into a section its reader may not open', () => {
    const found = files(SRC).flatMap((path) => {
      const rel = relative(SRC, path).split(sep).join('/');
      if (CHECKED_BY_HAND[rel]) return [];
      const own = OWN.find(([dir]) => rel.startsWith(`${dir}/`))?.[1] ?? null;
      const text = readFileSync(path, 'utf-8');
      return [...text.matchAll(RAW_LINK)]
        .filter((m) => m[1] !== own)
        .map((m) => `${rel}:${text.slice(0, m.index).split('\n').length} → /${m[1]}`);
    });
    expect(found).toEqual([]);
  });

  it('the scan sees a raw link at all', () => {
    expect([...'<Link to={`/products/${id}`} className="x">'.matchAll(RAW_LINK)].map((m) => m[1])).toEqual(['products']);
    expect([...'<Link\n  to="/stock?tab=notes"\n>'.matchAll(RAW_LINK)].map((m) => m[1])).toEqual(['stock']);
  });
});
