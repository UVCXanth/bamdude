/**
 * The order's dialogs have ONE host (WS-13 E6 B01): `orderActions/useOrderActions`.
 * A page, a view or a card that mounts one of them itself is a second way to open
 * the same action — the one that drifts (the issue dialog used to be mounted in
 * three places, the duplicate ran as a bare mutation from two lists).
 *
 * A text scan: auxiliary to the behavioural tests in `orderActions.test.tsx`.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');
const HOST_DIR = ['components', 'projects', 'orderActions'].join(sep);
const DIALOGS = ['FulfilmentDialog', 'DuplicateOrderModal', 'OrderModal', 'OrderCoverDialog'];

function walk(dir: string, out: string[] = []): string[] {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name !== '__tests__') walk(p, out);
    } else if (d.name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

describe('order dialogs', () => {
  it('are mounted only by the action host', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (rel.startsWith(HOST_DIR)) continue;
      const text = readFileSync(file, 'utf8');
      for (const name of DIALOGS) {
        if (new RegExp(`<${name}[\\s/>]`).test(text)) offenders.push(`${rel}: <${name}>`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
