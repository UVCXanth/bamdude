/**
 * The Workshop renders its dates, times and prices from the curated settings copy (WS-13
 * E13 T17): an order clerk or a stock keeper is not a settings reader, and `GET /settings/`
 * answers them 403 — every price and date then falls back to the defaults, silently.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(process.cwd(), 'src');
const WORKSHOP = [
  'components/projects',
  'components/products',
  'components/customers',
  'components/stock',
  'pages/orders',
  'pages/products',
  'pages/customers',
  'pages/stock',
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('the Workshop reads no full settings', () => {
  it('no Workshop file asks GET /settings/', () => {
    const readers = WORKSHOP.flatMap((dir) => files(join(SRC, dir)))
      .filter((path) => readFileSync(path, 'utf-8').includes('api.getSettings'))
      .map((path) => relative(SRC, path));
    expect(readers).toEqual([]);
  });
});
