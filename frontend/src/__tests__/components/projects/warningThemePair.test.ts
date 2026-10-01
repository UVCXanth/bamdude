import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WS-13 E7 — a warning in the Workshop reads on both themes.
 *
 * A lone light amber (300–500) is the dark theme's colour: on the light ground
 * it measured 1.36:1 (the orders list's «short» chip); a lone red 400–500 —
 * «overdue», «late» — 3.8:1 at 11–12 px. Every such class carries its light
 * partner — `text-amber-700 dark:text-amber-400`, `text-red-600
 * dark:text-red-500`, an icon `text-amber-600 dark:text-amber-500`, a tint
 * `bg-amber-500/…` — so a token without the `dark:` prefix must not be one.
 */
const SRC = join(process.cwd(), 'src');
const DIRS = ['components/projects', 'components/workshop'];
const LONE_LIGHT_AMBER = /^(text|bg|border)-(amber-(300|400|500)|red-(400|500))$/;

function sources(dir: string): string[] {
  return readdirSync(join(SRC, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(SRC, rel)).isDirectory()) return sources(rel);
    return name.endsWith('.tsx') || name.endsWith('.ts') ? [rel] : [];
  });
}

describe('workshop warning colours', () => {
  it('pair every light amber and red with the light theme', () => {
    const files = DIRS.flatMap(sources);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((rel) =>
      readFileSync(join(SRC, rel), 'utf8')
        .split(/[\s'"`{}]+/)
        .filter((token) => LONE_LIGHT_AMBER.test(token))
        .map((token) => `${rel}: ${token}`),
    );
    expect(offenders).toEqual([]);
  });
});
