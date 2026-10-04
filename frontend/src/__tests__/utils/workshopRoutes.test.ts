/**
 * Every Workshop page sits behind its own domain's read (WS-13 E13 O13): a caller who may not
 * read a section is sent home rather than shown a page whose every request is refused. The
 * dispatch note opens with any of the three domains it belongs to — the server decides the
 * rest (O25). Read off the route table itself, so a new page or a lost wrapper fails here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf-8');

function gateOf(path: string): string | null {
  const route = APP.split('<Route').find((chunk) => chunk.includes(`path="${path}"`));
  if (!route) throw new Error(`no route ${path}`);
  const match = route.match(/<PermissionRoute permission=(\{[^}]*\}|"[^"]*")/);
  return match ? match[1] : null;
}

describe('the Workshop routes', () => {
  it.each([
    ['projects', '"orders:read"'],
    ['projects/:id', '"orders:read"'],
    ['products', '"products:read"'],
    ['products/:id', '"products:read"'],
    ['customers', '"customers:read"'],
    ['customers/:id', '"customers:read"'],
    ['stock', '"stock:read"'],
    ['stock/:id', '"stock:read"'],
  ])('%s asks %s', (path, gate) => {
    expect(gateOf(path)).toBe(gate);
  });

  it('a dispatch note opens with any of its three domains', () => {
    expect(gateOf('stock/dispatch-notes/:id')).toBe("{['stock:read', 'orders:read', 'customers:read']}");
  });
});
